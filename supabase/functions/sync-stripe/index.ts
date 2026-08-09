// ============================================================
// Edge Function : sync-stripe
// Synchronisation Stripe → Supabase (incremental ou full_sync)
// Déclenché par cron ou manuellement.
// Auth : service_role uniquement
// ============================================================
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { DataSyncLogger, type WriteError } from '../_shared/data-sync-logger.ts'
import { acquireCronLock, releaseCronLock } from '../_shared/cron-lock.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'
import { retryWithBackoff } from '../_shared/retry-with-backoff.ts'
import { CircuitBreaker } from '../_shared/circuit-breaker.ts'
import { alertSlack } from '../_shared/slack-alert.ts'
import { detectMrrCollapseAnomaly, type AccountMrrUpdate } from '../_shared/sync-anomaly-guard.ts'
import {
  calcSubscriptionMrrCents,
  aggregateAccountMrr,
  classifyMovement,
  detectOrgMajorityCurrency,
  type SubscriptionMrrResult,
  type StripeSubscriptionLike,
} from '../_shared/mrr-engine.ts'
import { dedupeMovementRows, writeMrrMovementsSync, type MrrMovementSyncRow } from '../_shared/mrr-movements-writer.ts'

const STRIPE_API_BASE = 'https://api.stripe.com/v1'
const PAGE_SIZE = 100
const MAX_PAGES = 50
const STRIPE_TIMEOUT_MS = 20000
const DB_BATCH_SIZE = 500

const stripeCircuitBreaker = new CircuitBreaker({
  name: 'stripe-api',
  failureThreshold: 5,
  resetTimeoutMs: 60000,
})

// ── Types Stripe ─────────────────────────────────────────────
interface StripeListResponse<T> {
  object: 'list'
  data: T[]
  has_more: boolean
  url: string
}

interface StripeCustomer {
  id: string
  object: 'customer'
  name?: string | null
  metadata?: Record<string, string>
  created: number
}

interface StripeSubscription extends StripeSubscriptionLike {
  id: string
  customer: string
  status: string
  quantity: number
  created: number
  plan?: { amount: number; interval: string; id: string; product: string; currency?: string }
  items?: {
    data: Array<{
      price: {
        id: string
        unit_amount: number | null
        currency?: string
        product: string
        recurring?: { interval: string; interval_count?: number; usage_type?: string }
        billing_scheme?: string
      }
      quantity?: number
    }>
  }
  discount?: { coupon: { percent_off?: number | null; amount_off?: number | null; duration: 'forever' | 'repeating' | 'once'; duration_in_months?: number | null } } | null
  discounts?: Array<{ coupon: { percent_off?: number | null; amount_off?: number | null; duration: 'forever' | 'repeating' | 'once'; duration_in_months?: number | null } }> | null
  trial_end?: number | null
  cancel_at?: number | null
  cancel_at_period_end?: boolean
  canceled_at?: number | null
  current_period_start: number
  current_period_end: number
}

interface StripeInvoice {
  id: string
  customer: string
  subscription?: string | null
  status: string
  amount_due: number
  currency: string
  created: number
  due_date?: number | null
  status_transitions?: { paid_at?: number | null }
}

// Détection du profil de facturation (Phase 3, docs/openspec.md §11) —
// signaux détectables sans coût (données déjà en mémoire pendant le sync)
// sauf has_subscription_schedules (un appel Stripe dédié, limit=1).
interface BillingProfileCounts {
  metered_subscriptions: number
  multi_item_subscriptions: number
  null_unit_amount_prices: number
  invoice_only_accounts: number
  multi_currency: boolean
  has_subscription_schedules: boolean
}

// ── Helpers Stripe API ────────────────────────────────────────
async function stripeGet<T>(
  path: string,
  apiKey: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${STRIPE_API_BASE}${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  }

  return retryWithBackoff(
    () =>
      stripeCircuitBreaker.execute(async () => {
        const resp = await fetchWithTimeout(
          url.toString(),
          { headers: { Authorization: `Bearer ${apiKey}` } },
          STRIPE_TIMEOUT_MS,
        )
        if (!resp.ok) {
          const err = await resp.text()
          throw new Error(`Stripe API ${path} → ${resp.status}: ${err}`)
        }
        return resp.json() as Promise<T>
      }),
    {
      maxRetries: 2,
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      jitter: true,
      retryOn: (err) => {
        const msg = err instanceof Error ? err.message : String(err)
        // Retry on 5xx and rate limits only — don't retry timeouts to avoid wall-clock exhaustion
        return msg.includes('→ 5') || msg.includes('→ 429')
      },
    },
  )
}

async function* paginateStripe<T>(
  path: string,
  apiKey: string,
  extraParams?: Record<string, string>,
  logger?: DataSyncLogger,
): AsyncGenerator<T> {
  let startingAfter: string | undefined
  let hasMore = true
  let pageCount = 0

  while (hasMore) {
    if (pageCount >= MAX_PAGES) {
      console.warn(JSON.stringify({
        level: 'warn',
        function_name: 'sync-stripe',
        message: `Pagination limit reached (${MAX_PAGES} pages) for ${path}`,
      }))
      break
    }

    const params: Record<string, string> = {
      limit: String(PAGE_SIZE),
      ...extraParams,
    }
    if (startingAfter) params['starting_after'] = startingAfter

    const page = await stripeGet<StripeListResponse<T & { id: string }>>(path, apiKey, params)
    logger?.increment('api_calls_made')
    pageCount++

    for (const item of page.data) {
      yield item as unknown as T
    }

    hasMore = page.has_more
    if (hasMore && page.data.length > 0) {
      startingAfter = page.data[page.data.length - 1].id
    }
  }
}

// ── Helpers subscription ─────────────────────────────────────
// calcSubscriptionMrrCents (MRR: tous les items, interval_count, remises,
// trials, metered/null-unit_amount -> unavailable) vient de _shared/mrr-engine.ts —
// seule implémentation autorisée (docs/openspec.md §13). Plus de formule
// locale dupliquée ici.

// Retourne le stripe_price_id de l'abonnement actif principal.
// Critère : MRR le plus élevé. Tie-break : le plus récemment créé (created DESC).
function getPrimaryPriceId(subs: Array<{
  mrrCents: number
  createdAt: number
  priceId: string | null
}>): string | null {
  if (subs.length === 0) return null
  const sorted = subs.slice().sort((a, b) => {
    if (b.mrrCents !== a.mrrCents) return b.mrrCents - a.mrrCents
    return b.createdAt - a.createdAt
  })
  return sorted[0].priceId
}

// ── Helpers batch ─────────────────────────────────────────────
// writeErrors : erreur Postgres réelle de chaque chunk en échec, poussée
// dans le tableau partagé de l'appelant (un seul par run d'org, passé à
// travers syncCustomers/syncSubscriptions/syncInvoices) pour que
// DataSyncLogger.complete() puisse enfin l'écrire dans error_message —
// avant l'incident du 2026-08-04, elle finissait uniquement en
// console.error, jamais persistée (voir _shared/data-sync-logger.ts).
async function batchUpsert<T extends Record<string, unknown>>(
  supabase: SupabaseClient,
  table: string,
  rows: T[],
  onConflict: string,
  writeErrors: WriteError[],
): Promise<{ processed: number; failed: number }> {
  let processed = 0
  let failed = 0
  for (let i = 0; i < rows.length; i += DB_BATCH_SIZE) {
    const chunk = rows.slice(i, i + DB_BATCH_SIZE)
    const { error } = await supabase.from(table).upsert(chunk, { onConflict, ignoreDuplicates: false })
    if (error) {
      console.error(JSON.stringify({
        level: 'error', function_name: 'sync-stripe',
        message: `batch upsert ${table} failed`,
        error_message: error.message, error_code: error.code,
        error_details: error.details, error_hint: error.hint,
        chunk_size: chunk.length, chunk_offset: i,
      }))
      writeErrors.push({ table, message: error.message, code: error.code ?? null })
      failed += chunk.length
    } else {
      processed += chunk.length
    }
  }
  return { processed, failed }
}

// ── Sync customers → accounts ─────────────────────────────────
async function syncCustomers(
  supabase: SupabaseClient,
  organizationId: string,
  apiKey: string,
  logger: DataSyncLogger,
  writeErrors: WriteError[],
  createdAfter?: number,
): Promise<void> {
  const extraParams: Record<string, string> = {}
  if (createdAfter) extraParams['created[gt]'] = String(createdAfter)

  const syncedAt = new Date().toISOString()
  const rows: Record<string, unknown>[] = []

  for await (const customer of paginateStripe<StripeCustomer>('/customers', apiKey, extraParams, logger)) {
    const row: Record<string, unknown> = {
      organization_id: organizationId,
      stripe_customer_id: customer.id,
      last_stripe_sync_at: syncedAt,
    }
    // customer.name est un nom d'entreprise (personne morale) en contexte B2B — Zero-PII compatible.
    // Si null, on ne l'inclut pas pour que l'upsert ne soit pas converti en UPDATE implicite
    // qui écraserait un display_name renseigné manuellement.
    if (customer.name) row.display_name = customer.name
    rows.push(row)
  }

  const { processed, failed } = await batchUpsert(supabase, 'accounts', rows, 'organization_id,stripe_customer_id', writeErrors)
  logger.increment('records_processed', processed)
  logger.increment('accounts_processed', processed)
  logger.increment('records_failed', failed)
}

// ── Sync subscriptions ────────────────────────────────────────
// Always full-syncs (no createdAfter filter) because Stripe's
// created[gt] filter misses subscription updates/cancellations.
async function syncSubscriptions(
  supabase: SupabaseClient,
  organizationId: string,
  apiKey: string,
  logger: DataSyncLogger,
  writeErrors: WriteError[],
  restatementMode = false,
): Promise<{ anomalyDetected: boolean; billingProfile?: BillingProfileCounts; restatementAccountsCount?: number }> {
  const extraParams: Record<string, string> = { status: 'all' }

  // Détection du profil de facturation (Phase 3, docs/openspec.md §11) —
  // compteurs bruts calculés en marge du même passage sur les subscriptions
  // de l'org, zéro appel Stripe supplémentaire (sauf has_subscription_schedules).
  const billingProfileCounts: BillingProfileCounts = {
    metered_subscriptions: 0,
    multi_item_subscriptions: 0,
    null_unit_amount_prices: 0,
    invoice_only_accounts: 0,
    multi_currency: false,
    has_subscription_schedules: false,
  }

  // Pre-build stripe_customer_id → account.id Map (eliminates N+1 queries)
  // + snapshot du MRR/mrr_status actuels pour détecter les mouvements
  const { data: subSyncAccounts } = await supabase
    .from('accounts')
    .select('id, stripe_customer_id, mrr_cents, mrr_status')
    .eq('organization_id', organizationId)

  const customerToAccount = new Map<string, string>()
  const prevMrrByAccount = new Map<string, number>()
  const prevMrrStatusByAccount = new Map<string, 'ok' | 'unavailable'>()
  for (const a of subSyncAccounts ?? []) {
    if (a.stripe_customer_id) customerToAccount.set(a.stripe_customer_id, a.id)
    prevMrrByAccount.set(a.id, a.mrr_cents ?? 0)
    prevMrrStatusByAccount.set(a.id, a.mrr_status === 'unavailable' ? 'unavailable' : 'ok')
  }

  // Track per-account metadata from active subs for MRR aggregation
  const accountSubMeta = new Map<string, Array<{
    status: string
    result: SubscriptionMrrResult
    billingInterval: string
    quantity: number
    contractStart: string | null
    contractEnd: string | null
    priceId: string | null
    createdAt: number
  }>>()

  // Devises des subscriptions billables de l'org, pour le vote majoritaire
  // (docs/openspec.md §9) appliqué ci-dessous par compte.
  const orgSubscriptionCurrencies: Array<{ currency: string | null }> = []
  // canceled_at le plus récent par compte — permet de dater un mouvement
  // `churn` à la date effective d'annulation Stripe plutôt qu'à la date du
  // run de sync (docs/openspec.md §10). Pas d'équivalent pour new/expansion/
  // contraction dans ce chemin batch : sync-stripe compare deux snapshots
  // sans qu'un événement Stripe unique ne soit rattachable à ces
  // transitions (contrairement à stripe-webhook, event-driven — voir
  // handleSubscriptionEvent). Limitation documentée, pas un oubli.
  const accountLatestCanceledAt = new Map<string, number>()

  // Collect all subscription rows — batch upsert at the end
  const subRows: Record<string, unknown>[] = []

  for await (const sub of paginateStripe<StripeSubscription>('/subscriptions', apiKey, extraParams, logger)) {
    const accountId = customerToAccount.get(sub.customer)
    if (!accountId) {
      logger.increment('records_failed')
      continue
    }

    if (sub.status === 'canceled' && sub.canceled_at) {
      const existing = accountLatestCanceledAt.get(accountId) ?? 0
      if (sub.canceled_at > existing) accountLatestCanceledAt.set(accountId, sub.canceled_at)
    }

    // Compteurs de profil de facturation (Phase 3) — indépendants du statut,
    // une subscription non-standard reste un signal même si canceled.
    const items = sub.items?.data ?? []
    if (items.length > 1) billingProfileCounts.multi_item_subscriptions++
    if (items.some((i) => i.price.recurring?.usage_type === 'metered')) billingProfileCounts.metered_subscriptions++
    if (items.some((i) => i.price.unit_amount === null || i.price.unit_amount === undefined)) billingProfileCounts.null_unit_amount_prices++

    const mrrResult = calcSubscriptionMrrCents(sub)
    const qty = sub.items?.data?.[0]?.quantity ?? sub.quantity ?? 1

    subRows.push({
      organization_id: organizationId,
      account_id: accountId,
      stripe_sub_id: sub.id,
      stripe_price_id: sub.items?.data?.[0]?.price?.id ?? null,
      stripe_product_id: sub.items?.data?.[0]?.price?.product ?? null,
      status: sub.status,
      mrr_cents: mrrResult.mrr_cents,
      trial_mrr_cents: mrrResult.trial_mrr_cents,
      mrr_status: mrrResult.mrr_status,
      currency: mrrResult.currency,
      interval_raw: mrrResult.interval_raw,
      interval_count: mrrResult.interval_count,
      quantity: qty,
      trial_end_date: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString().split('T')[0] : null,
      cancel_at: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString().split('T')[0] : null,
      canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
    })

    // Collect metadata from billable subs for account MRR propagation.
    // past_due/unpaid ajoutés ici (docs/openspec.md §5) : un compte
    // délinquant reste compté dans le MRR, jamais silencieusement mis à
    // zéro — c'est ce qui évite qu'il se retrouve, en aval, court-circuité
    // comme "churned" (AUDIT_LOGIQUE_METIER_STRIPE.md point 6).
    if (sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due' || sub.status === 'unpaid') {
      const periodStart = sub.current_period_start
        ? new Date(sub.current_period_start * 1000).toISOString().split('T')[0]
        : null
      const periodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString().split('T')[0]
        : null
      const list = accountSubMeta.get(accountId) ?? []
      list.push({
        status: sub.status,
        result: mrrResult,
        billingInterval: mrrResult.interval_raw === 'year' ? 'annual' : 'monthly',
        quantity: qty,
        contractStart: periodStart,
        contractEnd: periodEnd,
        priceId: sub.items?.data?.[0]?.price?.id ?? null,
        createdAt: sub.created,
      })
      accountSubMeta.set(accountId, list)
      orgSubscriptionCurrencies.push({ currency: mrrResult.currency })
    }
  }

  const orgMajorityCurrency = detectOrgMajorityCurrency(orgSubscriptionCurrencies)
  billingProfileCounts.multi_currency = new Set(
    orgSubscriptionCurrencies.map((c) => c.currency).filter((c): c is string => c !== null),
  ).size > 1

  // has_subscription_schedules : un seul appel Stripe dédié, limit=1 — ne
  // sert qu'à savoir si l'org en utilise, jamais à en lire le détail dans
  // cette itération (docs/openspec.md §8.3, hors périmètre de calcul MRR).
  try {
    const schedules = await stripeGet<StripeListResponse<{ id: string }>>('/subscription_schedules', apiKey, { limit: '1' })
    billingProfileCounts.has_subscription_schedules = schedules.data.length > 0
  } catch (err) {
    console.warn(JSON.stringify({
      level: 'warn', function_name: 'sync-stripe', organization_id: organizationId,
      message: `subscription_schedules check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    }))
  }

  // Devise d'affichage de l'org : vote majoritaire sur les subscriptions de
  // CE run (docs/openspec.md §9), remplace l'ancienne convention "première
  // ligne d'invoice du batch" (syncInvoices avant ce chantier) qui flappait
  // selon l'ordre de pagination Stripe plutôt que de refléter un état
  // stable de l'org (AUDIT_LOGIQUE_METIER_STRIPE.md point 7).
  if (orgMajorityCurrency) {
    const { error: currencyError } = await supabase
      .from('organizations')
      .update({ currency: orgMajorityCurrency })
      .eq('id', organizationId)
    if (currencyError) {
      console.error(JSON.stringify({
        level: 'error', function_name: 'sync-stripe', organization_id: organizationId,
        message: `Failed to update organizations.currency: ${currencyError.message}`,
      }))
    }
  }

  // Phase 1 : batch upsert subscriptions
  const { processed: subOk, failed: subFail } = await batchUpsert(supabase, 'subscriptions', subRows, 'stripe_sub_id', writeErrors)
  logger.increment('records_processed', subOk)
  logger.increment('subscriptions_processed', subOk)
  logger.increment('records_failed', subFail)

  // Phase 2 : batch upsert account MRR aggregates
  // upsert on accounts with onConflict='id' to batch-update all in one round-trip per 500 rows

  // Récupérer le mapping price_id → plan_tier/seat_limit une seule fois pour toute la sync
  const { data: productMappings } = await supabase
    .from('stripe_product_mappings')
    .select('stripe_price_id, plan_tier, seat_limit, unlimited_seats')
    .eq('organization_id', organizationId)

  const mappingByPriceId = new Map(
    (productMappings ?? []).map((m: {
      stripe_price_id: string
      plan_tier: string | null
      seat_limit: number | null
      unlimited_seats: boolean
    }) => [m.stripe_price_id, m]),
  )

  // mrr_status/mrr_cents par compte, désormais persisté sur accounts
  // (migration 20260804000001, docs/openspec.md §12) — conservés en mémoire
  // ici aussi pour la classification des mouvements (Phase 3 ci-dessous),
  // qui doit réutiliser exactement la valeur agrégée par aggregateAccountMrr
  // (exclusion des devises minoritaires notamment) plutôt que la
  // recalculer naïvement.
  const accountMrrStatus = new Map<string, 'ok' | 'unavailable'>()
  const newMrrByAccount = new Map<string, number>()

  const accountUpdateRows: Record<string, unknown>[] = []
  for (const acctId of customerToAccount.values()) {
    const subs = accountSubMeta.get(acctId) ?? []
    const agg = aggregateAccountMrr(
      subs.map((s) => ({ status: s.status, result: s.result })),
      orgMajorityCurrency,
    )
    const totalSeats = subs.reduce((sum, s) => sum + s.quantity, 0)
    const primary = subs.length > 0 ? subs.slice().sort((a, b) => b.result.mrr_cents - a.result.mrr_cents)[0] : null
    newMrrByAccount.set(acctId, agg.mrr_cents)
    accountMrrStatus.set(acctId, agg.mrr_status)

    // Résoudre le mapping produit à partir du price_id de l'abonnement principal
    const primaryPriceId = getPrimaryPriceId(subs.map((s) => ({ mrrCents: s.result.mrr_cents, createdAt: s.createdAt, priceId: s.priceId })))
    const mapping = primaryPriceId ? mappingByPriceId.get(primaryPriceId) : undefined
    const planTier = mapping?.plan_tier ?? null
    // seat_limit = NULL si mapping absent, non configuré, ou unlimited_seats = true
    const seatLimit = mapping ? (mapping.unlimited_seats ? null : (mapping.seat_limit ?? null)) : null

    // Forme canonique obligatoire (incident 2026-08-04, IMPLEMENTATION_LOG.md
    // — régression de la PR MRR engine v2) : batchUpsert() envoie ce tableau
    // en un seul .upsert() multi-lignes. Quand des lignes du même batch ont
    // des clés différentes, PostgREST doit unifier la liste de colonnes de
    // l'INSERT sur tout le batch — les lignes où une clé est absente
    // reçoivent un NULL explicite pour cette colonne, PAS le DEFAULT de la
    // table (le DEFAULT ne s'applique que si la colonne est absente de la
    // liste de colonnes de l'INSERT tout entier, pas ligne par ligne). Une
    // seule ligne NULL sur une colonne NOT NULL fait échouer l'upsert
    // ENTIER (tout le chunk, pas juste cette ligne) — c'est exactement ce
    // qui s'est produit sur `billing_model` (NOT NULL, DEFAULT 'subscription',
    // mais assignée conditionnellement ci-dessous auparavant) : 100% des
    // comptes de chaque org sont restés bloqués aux defaults de migration
    // pendant que `sync_status` restait 'completed' (voir aussi le fix de
    // DataSyncLogger.complete() qui rendait ça invisible).
    //
    // Règle : toute colonne NOT NULL doit apparaître sur CHAQUE ligne du
    // batch avec une valeur explicite — jamais une affectation conditionnelle
    // de clé. Vérifié pour les 6 colonnes NOT NULL de ce chantier
    // (billing_model, mrr_status, is_delinquent, pending_cancellation,
    // is_zero_dollar_active, trial_mrr_cents) : les 5 autres étaient déjà
    // inconditionnelles, seule billing_model ne l'était pas.
    //
    // billing_model : mise à 'subscription' pour CHAQUE compte de ce batch,
    // pas seulement ceux avec une subscription connue ce run — sûr par
    // construction, puisque c'est déjà la valeur DEFAULT de la colonne, et
    // que syncInvoices() (juste après, même run) corrige explicitement en
    // 'invoice_only' les comptes qui le sont réellement (docs/openspec.md
    // §8.2) via un .update() séparé, indépendant de cet upsert.
    const row: Record<string, unknown> = {
      id: acctId,
      organization_id: organizationId,
      mrr_cents: agg.mrr_cents,
      arr_cents: agg.mrr_cents * 12,
      trial_mrr_cents: agg.trial_mrr_cents,
      mrr_status: agg.mrr_status,
      is_delinquent: agg.is_delinquent,
      pending_cancellation: agg.pending_cancellation,
      is_zero_dollar_active: agg.is_zero_dollar_active,
      seat_count: totalSeats > 0 ? totalSeats : null,
      plan_tier: planTier,
      seat_limit: seatLimit,
      currency: agg.currency ?? null,
      billing_model: 'subscription',
      billing_interval: primary ? primary.billingInterval : null,
      contract_start_date: primary ? primary.contractStart : null,
      contract_end_date: primary ? primary.contractEnd : null,
    }
    accountUpdateRows.push(row)
  }

  // Garde-fou anomalie : si une part anormale de comptes passerait à
  // mrr_cents=0 dans ce run, bloquer l'écriture accounts plutôt que
  // d'appliquer aveuglément des données potentiellement corrompues
  // (incident documenté : -55,3% de MRR en quelques jours). subscriptions
  // (Phase 1) est déjà écrite — acceptée comme limitation, auto-corrective
  // au prochain run full-sync une fois la cause traitée.
  //
  // Bypass explicite en restatementMode (Phase 2.4, docs/openspec.md) : le
  // passage au moteur MRR v2 change légitimement mrr_cents pour de
  // nombreux comptes en une seule fois (items multiples désormais sommés,
  // interval_count respecté, remises appliquées, trials exclus...) — ce
  // n'est pas l'anomalie que ce garde-fou est censé détecter. Chaque delta
  // est de toute façon journalisé dans mrr_restatements ci-dessous, jamais
  // appliqué silencieusement.
  const anomaly = detectMrrCollapseAnomaly(
    prevMrrByAccount,
    accountUpdateRows as unknown as AccountMrrUpdate[],
  )
  if (anomaly.isAnomaly && !restatementMode) {
    const pct = Math.round(anomaly.ratio * 100)
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'sync-stripe',
      organization_id: organizationId,
      message: `Anomalie MRR détectée : ${anomaly.affectedCount}/${anomaly.totalCount} comptes passent à mrr=0 (${pct}%) — écriture accounts bloquée pour cet org`,
    }))
    await alertSlack(
      `sync-stripe: anomalie MRR détectée sur l'org ${organizationId} — ${anomaly.affectedCount}/${anomaly.totalCount} comptes (${pct}%) passeraient à 0€ dans ce run. Écriture accounts bloquée, subscriptions déjà synchronisées (auto-corrective au prochain run).`,
      { level: 'critical' },
    )
    return { anomalyDetected: true }
  }
  if (anomaly.isAnomaly && restatementMode) {
    console.warn(JSON.stringify({
      level: 'warn',
      function_name: 'sync-stripe',
      organization_id: organizationId,
      message: `restatement_mode: garde-fou d'anomalie MRR bypassé explicitement (${anomaly.affectedCount}/${anomaly.totalCount} comptes) — changement de formule attendu, journalisé dans mrr_restatements.`,
    }))
  }

  if (restatementMode) {
    // Phase 3 (restatement) : journaliser chaque delta dans mrr_restatements,
    // ZÉRO mrr_movements généré — un changement de formule n'est pas un
    // événement métier (docs/openspec.md §10, Phase 2.4). Les comptes dont
    // le mrr_cents n'a pas changé ne sont pas journalisés (bruit inutile).
    //
    // Écrit mrr_restatements AVANT accounts (ordre inversé du chemin normal
    // ci-dessous, délibéré — trouvé lors de l'auto-vérification
    // adversariale du 2026-08-04) : si ce run est interrompu entre les deux
    // écritures (crash, timeout — batchUpsert committe par chunks de
    // DB_BATCH_SIZE, un run sur un gros org peut prendre plusieurs minutes),
    // un rejeu doit retrouver l'ancien accounts.mrr_cents encore en base
    // pour recalculer le même delta et le ré-upserter (idempotent — contrainte
    // unique account_id+reason, migration 20260804000006) AVANT que accounts
    // ne bascule vers la nouvelle valeur. Dans l'ordre inverse (accounts
    // d'abord), un rejeu après une interruption entre les deux verrait déjà
    // le nouveau accounts.mrr_cents comme "previous", ne détecterait plus
    // aucun delta pour ces comptes, et perdrait silencieusement leur ligne
    // d'audit — faussant la requête de vérification du RUNBOOK sans aucune
    // erreur visible.
    const restatementRows: Record<string, unknown>[] = []
    for (const acctId of customerToAccount.values()) {
      const newMrr = newMrrByAccount.get(acctId) ?? 0
      const prevMrr = prevMrrByAccount.get(acctId) ?? 0
      if (newMrr !== prevMrr) {
        restatementRows.push({
          organization_id: organizationId,
          account_id: acctId,
          old_mrr_cents: prevMrr,
          new_mrr_cents: newMrr,
          reason: 'mrr_engine_v2_migration',
        })
      }
    }

    if (restatementRows.length > 0) {
      const { failed: restFail } = await batchUpsert(supabase, 'mrr_restatements', restatementRows, 'account_id,reason', writeErrors)
      if (restFail > 0) {
        console.error(JSON.stringify({
          level: 'error', function_name: 'sync-stripe', organization_id: organizationId,
          message: `${restFail} mrr_restatements rows failed to insert`,
        }))
      }
    }

    const { failed: acctFailRestate } = await batchUpsert(supabase, 'accounts', accountUpdateRows, 'id', writeErrors)
    logger.increment('records_failed', acctFailRestate)

    console.log(JSON.stringify({
      level: 'info', function_name: 'sync-stripe', organization_id: organizationId,
      message: `restatement_mode: ${restatementRows.length}/${customerToAccount.size} comptes restated, 0 mrr_movements générés`,
    }))

    return { anomalyDetected: false, billingProfile: billingProfileCounts, restatementAccountsCount: restatementRows.length }
  }

  const { failed: acctFail } = await batchUpsert(supabase, 'accounts', accountUpdateRows, 'id', writeErrors)
  logger.increment('records_failed', acctFail)

  // Phase 3 : générer les mrr_movements — classification centralisée
  // (classifyMovement, _shared/mrr-engine.ts, docs/openspec.md §7 et §11
  // audit) au lieu d'un diff avant/après ad-hoc. Réactivation détectée au
  // niveau compte (hasPriorChurnMovement), symétrique avec stripe-webhook —
  // avant ce changement, seul le chemin webhook tentait cette distinction
  // (et échouait en pratique, un nouvel objet Subscription Stripe étant
  // toujours créé après une annulation).
  // Idempotent grâce à l'index unique (org_id, account_id, movement_date, movement_type) WHERE stripe_event_id IS NULL
  const today = new Date().toISOString().split('T')[0]
  const movementRows: MrrMovementSyncRow[] = []

  const { data: priorChurnRows } = await supabase
    .from('mrr_movements')
    .select('account_id')
    .eq('organization_id', organizationId)
    .eq('movement_type', 'churn')
  const accountsWithPriorChurn = new Set((priorChurnRows ?? []).map((r: { account_id: string }) => r.account_id))

  for (const acctId of customerToAccount.values()) {
    const newMrr = newMrrByAccount.get(acctId) ?? 0
    const prevMrr = prevMrrByAccount.get(acctId) ?? 0

    const movement = classifyMovement({
      previous: { mrr_cents: prevMrr, mrr_status: prevMrrStatusByAccount.get(acctId) ?? 'ok' },
      current: { mrr_cents: newMrr, mrr_status: accountMrrStatus.get(acctId) ?? 'ok' },
      hasPriorChurnMovement: accountsWithPriorChurn.has(acctId),
    })

    if (movement) {
      // Pour un churn, dater à la date effective d'annulation Stripe
      // (canceled_at) quand connue — plus précis que "aujourd'hui" pour un
      // compte annulé depuis plusieurs jours mais seulement rattrapé par ce
      // run (docs/openspec.md §10). Pas d'équivalent pour les autres types
      // de mouvement dans ce chemin batch (voir commentaire plus haut).
      const canceledAtMs = movement.movement_type === 'churn' ? accountLatestCanceledAt.get(acctId) : undefined
      const movementDate = canceledAtMs ? new Date(canceledAtMs * 1000).toISOString().split('T')[0] : today

      movementRows.push({
        organization_id: organizationId,
        account_id: acctId,
        movement_type: movement.movement_type,
        amount_cents: movement.amount_cents,
        movement_date: movementDate,
      })
    }
  }

  const dedupedMovementRows = dedupeMovementRows(movementRows)
  const { processed: movementsProcessed, failed: movementsFailed, writeError: mvtWriteError } =
    await writeMrrMovementsSync(supabase, dedupedMovementRows)
  logger.increment('movements_processed', movementsProcessed)
  logger.increment('records_failed', movementsFailed)
  if (mvtWriteError) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'sync-stripe',
      organization_id: organizationId,
      message: `mrr_movements write failed: ${mvtWriteError.message}`,
    }))
    writeErrors.push(mvtWriteError)
  }

  return { anomalyDetected: false, billingProfile: billingProfileCounts }
}

// ── Sync invoices ─────────────────────────────────────────────
async function syncInvoices(
  supabase: SupabaseClient,
  organizationId: string,
  apiKey: string,
  logger: DataSyncLogger,
  writeErrors: WriteError[],
  createdAfter?: number,
): Promise<{ invoiceOnlyAccountsCount: number }> {
  const extraParams: Record<string, string> = {}
  if (createdAfter) extraParams['created[gt]'] = String(createdAfter)

  // Pre-build lookup Maps (eliminates N+1 queries)
  const [acctResult, subResult] = await Promise.all([
    supabase.from('accounts').select('id, stripe_customer_id').eq('organization_id', organizationId),
    supabase.from('subscriptions').select('id, stripe_sub_id, account_id').eq('organization_id', organizationId),
  ])

  const invoiceCustomerMap = new Map<string, string>()
  for (const a of acctResult.data ?? []) {
    if (a.stripe_customer_id) invoiceCustomerMap.set(a.stripe_customer_id, a.id)
  }

  const stripeSubMap = new Map<string, string>()
  const accountsWithSubscriptions = new Set<string>()
  for (const s of subResult.data ?? []) {
    if (s.stripe_sub_id) stripeSubMap.set(s.stripe_sub_id, s.id)
    if (s.account_id) accountsWithSubscriptions.add(s.account_id)
  }

  const invoiceRows: Record<string, unknown>[] = []
  const accountsWithInvoices = new Set<string>()
  let orphaned = 0 // invoices for Stripe customers not yet in accounts — not a failure

  for await (const invoice of paginateStripe<StripeInvoice>('/invoices', apiKey, extraParams, logger)) {
    const accountId = invoiceCustomerMap.get(invoice.customer)
    if (!accountId) {
      orphaned++
      continue
    }
    accountsWithInvoices.add(accountId)

    const subscriptionId = invoice.subscription ? (stripeSubMap.get(invoice.subscription) ?? null) : null
    const paidAt = invoice.status_transitions?.paid_at
      ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
      : null

    invoiceRows.push({
      organization_id: organizationId,
      account_id: accountId,
      subscription_id: subscriptionId,
      stripe_invoice_id: invoice.id,
      amount_cents: invoice.amount_due,
      currency: invoice.currency,
      status: invoice.status,
      invoice_date: new Date(invoice.created * 1000).toISOString().split('T')[0],
      due_date: invoice.due_date ? new Date(invoice.due_date * 1000).toISOString().split('T')[0] : null,
      paid_at: paidAt,
    })
  }

  const { processed, failed } = await batchUpsert(supabase, 'invoices', invoiceRows, 'stripe_invoice_id', writeErrors)
  logger.increment('records_processed', processed)
  logger.increment('invoices_processed', processed)
  logger.increment('records_failed', failed)

  // Détection billing_model='invoice_only' (docs/openspec.md §8.2) : un
  // customer avec ≥1 invoice mais 0 subscription connue est facturé
  // manuellement (send_invoice). mrr_status='unavailable' déjà écrit par
  // syncSubscriptions pour ces comptes (aggregateAccountMrr sur une liste
  // vide) — ce correctif ajoute uniquement la classification explicite,
  // jamais un MRR de repli dans cette itération (hors périmètre, voir
  // docs/openspec.md §11).
  const invoiceOnlyAccountIds = [...accountsWithInvoices].filter((id) => !accountsWithSubscriptions.has(id))
  if (invoiceOnlyAccountIds.length > 0) {
    const { error: invoiceOnlyError } = await supabase
      .from('accounts')
      .update({ billing_model: 'invoice_only' })
      .in('id', invoiceOnlyAccountIds)
    if (invoiceOnlyError) {
      console.error(JSON.stringify({
        level: 'error', function_name: 'sync-stripe', organization_id: organizationId,
        message: `Failed to flag invoice_only accounts: ${invoiceOnlyError.message}`,
      }))
    } else {
      console.log(JSON.stringify({
        level: 'info', function_name: 'sync-stripe', organization_id: organizationId,
        message: `${invoiceOnlyAccountIds.length} comptes classés billing_model='invoice_only'`,
      }))
    }
  }

  if (orphaned > 0) {
    console.warn(JSON.stringify({
      level: 'warn', function_name: 'sync-stripe',
      message: `${orphaned} invoices skipped — no matching account (expected during initial sync)`,
    }))
  }

  return { invoiceOnlyAccountsCount: invoiceOnlyAccountIds.length }
}

// ── Entrypoint ───────────────────────────────────────────────
Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  let body: {
    organization_id?: string
    sync_type?: 'incremental' | 'full_sync'
    created_after?: number
    is_manual?: boolean
    triggered_by?: string
    // Phase 2.4 (docs/openspec.md, IMPLEMENTATION_LOG.md) : mode de
    // migration one-shot, déclenché explicitement par un opérateur — jamais
    // par le cron ni par aucun webhook. Recalcule accounts.mrr_cents avec
    // le nouveau moteur SANS générer de mrr_movements (journalise chaque
    // delta dans mrr_restatements à la place) et bypass le garde-fou
    // d'anomalie MRR (le changement de formule affecte légitimement de
    // nombreux comptes en un seul run).
    restatement_mode?: boolean
  } = {}

  try {
    body = await req.json()
  } catch {
    // Body optionnel
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'sync-stripe', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const syncType = body.sync_type ?? 'incremental'
  const isManual = body.is_manual ?? false
  const triggeredBy = body.triggered_by ?? 'cron'
  const isOnboarding = triggeredBy === 'onboarding'
  const restatementMode = body.restatement_mode === true

  // ── Résoudre les orgs à traiter ──────────────────────────────
  // Avec organization_id → 1 org ciblée
  // Sans organization_id → toutes les orgs actives avec une clé Stripe (mode cron)
  let orgsToSync: Array<{ id: string; stripe_api_key: string | null }> = []

  if (body.organization_id) {
    const { data, error } = await supabase
      .from('organizations')
      .select('id, stripe_api_key')
      .eq('id', body.organization_id)
      .eq('is_active', true)
      .maybeSingle()
    if (error) console.error(JSON.stringify({ level: 'error', function_name: 'sync-stripe', step: 'org_query', error: error.message }))
    if (data) orgsToSync = [data]
  } else {
    const { data, error } = await supabase
      .from('organizations')
      .select('id, stripe_api_key')
      .eq('is_active', true)
      .order('created_at', { ascending: true })
    if (error) console.error(JSON.stringify({ level: 'error', function_name: 'sync-stripe', step: 'orgs_query', error: error.message }))
    orgsToSync = (data ?? []).filter((o) => o.stripe_api_key || Deno.env.get('STRIPE_SECRET_KEY'))
  }

  if (orgsToSync.length === 0) {
    return errorResponse('No active organization with Stripe key found', 404)
  }

  console.log(JSON.stringify({ level: 'info', function_name: 'sync-stripe', step: 'orgs_resolved', count: orgsToSync.length, sync_type: syncType }))

  // ── Si plusieurs orgs → traitement séquentiel (fire-and-return) ─
  if (orgsToSync.length > 1) {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const results: Array<{ organization_id: string; status: string }> = []

    for (const org of orgsToSync) {
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/sync-stripe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
          body: JSON.stringify({ organization_id: org.id, sync_type: syncType, triggered_by: triggeredBy, restatement_mode: restatementMode }),
          signal: AbortSignal.timeout(280000), // 280s — laisse 20s de marge avant timeout Edge Function
        })
        results.push({ organization_id: org.id, status: res.ok ? 'triggered' : `http_${res.status}` })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(JSON.stringify({ level: 'warn', function_name: 'sync-stripe', organization_id: org.id, message: `dispatch failed: ${msg}` }))
        results.push({ organization_id: org.id, status: 'error' })
      }
    }

    return jsonResponse({ success: true, mode: 'all_orgs', results })
  }

  // ── Traitement d'une seule org ────────────────────────────────
  const organizationId = orgsToSync[0].id
  const apiKey = orgsToSync[0].stripe_api_key ?? Deno.env.get('STRIPE_SECRET_KEY')
  if (!apiKey) {
    return errorResponse('Stripe key not configured. Add your key under Integrations → Stripe.', 500)
  }

  // Pour le sync incrémental, récupérer la date du dernier sync
  let createdAfter: number | undefined
  if (syncType === 'incremental') {
    const { data: lastSync } = await supabase
      .from('data_syncs')
      .select('completed_at')
      .eq('organization_id', organizationId)
      .eq('sync_source', 'stripe')
      .eq('sync_status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (lastSync?.completed_at) {
      const lastSyncMs = new Date(lastSync.completed_at).getTime()
      if (lastSyncMs > 0 && lastSyncMs <= Date.now()) {
        createdAfter = Math.floor(lastSyncMs / 1000) - 3600 // -1h de marge
      } else {
        console.warn(JSON.stringify({
          level: 'warn',
          function_name: 'sync-stripe',
          message: `Invalid lastSync timestamp: ${lastSync.completed_at}, falling back to full sync`,
        }))
      }
    }
  }

  const logger = new DataSyncLogger({
    supabase,
    organizationId,
    syncSource: 'stripe',
    syncType,
    triggeredBy: isManual ? 'manual' : 'cron',
    isManual,
  })

  // Lock toujours per-org (pas de lock global) pour permettre les syncs parallèles.
  // Même lockName qu'un sync normal (délibéré) : un restatement et un sync
  // cron/webhook pour le même org ne doivent jamais s'exécuter en même temps
  // — l'un des deux échoue proprement sur 409 plutôt que d'écrire des
  // valeurs mrr_cents à moitié restatées en même temps qu'un webhook les
  // recalcule avec l'état "previous" d'avant restatement (trouvé lors de
  // l'auto-vérification adversariale du 2026-08-04).
  //
  // TTL élevé à 600s (au lieu de 300s) en restatement_mode : ce mode
  // recalcule TOUTES les subscriptions de l'org (jusqu'à MAX_PAGES=50 pages
  // × 3 ressources) au lieu d'un sync incrémental, un run peut légitimement
  // dépasser 300s sur une org avec beaucoup de comptes — avec un TTL de
  // 300s, le lock serait nettoyé comme "expiré" par le prochain appelant
  // pendant que le restatement tourne encore, permettant à un cron sync
  // concurrent de démarrer sur le même org malgré la contrainte UNIQUE.
  const lockName = `sync-stripe-${organizationId}`
  const lockTtlSeconds = restatementMode ? 600 : 300
  const lockAcquired = await acquireCronLock(supabase, lockName, lockTtlSeconds)
  if (!lockAcquired) {
    return errorResponse('Sync already in progress for this organization', 409)
  }

  // Second lock, restatement-only (trouvé lors de la revue de merge du
  // 2026-08-04 : isCronLockHeld côté stripe-webhook lisait à tort le lock
  // partagé `sync-stripe-<org_id>` ci-dessus — le webhook différait donc sa
  // mise à jour accounts.mrr_cents/classification de mouvement pendant
  // N'IMPORTE QUEL sync-stripe, y compris un sync quotidien normal, pas
  // seulement pendant un restatement. Un webhook arrivant dans la fenêtre
  // (jusqu'à 300s) d'un sync normal aurait alors attendu le prochain sync
  // planifié — jusqu'à 24h — pour voir son événement reflété, une
  // dégradation du temps réel non voulue et jamais actée avec Naima.
  // Ce second lock, acquis uniquement en restatement_mode, laisse
  // stripe-webhook distinguer les deux cas sans toucher au lock partagé
  // ci-dessus (qui reste la garantie de non-chevauchement restatement/sync
  // normal — inchangée).
  const restatementLockName = `restatement-${organizationId}`
  if (restatementMode) {
    const restatementLockAcquired = await acquireCronLock(supabase, restatementLockName, lockTtlSeconds)
    if (!restatementLockAcquired) {
      // Ne devrait jamais arriver (le lock partagé ci-dessus garantit déjà
      // l'exclusivité) sauf marqueur périmé d'un restatement précédent qui
      // a crashé sans le libérer — purement informatif pour stripe-webhook,
      // pas un vrai verrou de concurrence : on continue sans bloquer le run.
      console.warn(JSON.stringify({
        level: 'warn',
        function_name: 'sync-stripe',
        organization_id: organizationId,
        message: `Could not acquire restatement marker lock "${restatementLockName}" (stale from a previous run?) — continuing, stripe-webhook may not defer correctly during this run.`,
      }))
    }
  }

  await logger.start()

  // Partagé par les trois étapes du sync — chaque batchUpsert() en échec y
  // pousse l'erreur Postgres réelle (voir _shared/data-sync-logger.ts),
  // transmis à logger.complete() plus bas pour qu'il ne se déclare plus
  // 'completed' silencieusement quand records_failed > 0.
  const writeErrors: WriteError[] = []

  try {
    await syncCustomers(supabase, organizationId, apiKey, logger, writeErrors, createdAfter)
    const { anomalyDetected, billingProfile, restatementAccountsCount } = await syncSubscriptions(supabase, organizationId, apiKey, logger, writeErrors, restatementMode)
    const { invoiceOnlyAccountsCount } = await syncInvoices(supabase, organizationId, apiKey, logger, writeErrors, createdAfter)

    if (anomalyDetected) {
      // 'validation_error' — CHECK data_syncs_error_type_check n'inclut pas de valeur
      // dédiée aux anomalies de données, c'est la plus proche sémantiquement.
      await logger.fail('MRR anomaly detected — accounts write blocked for this run', 'validation_error')
      return errorResponse('Sync completed with MRR anomaly — accounts write blocked, see logs/Slack', 409)
    }

    // Profil de facturation (Phase 3, docs/openspec.md §11) : agrège les
    // compteurs de syncSubscriptions avec le compte invoice_only calculé
    // par syncInvoices (qui tourne après, seul à avoir la vue complète
    // invoices × subscriptions). needs_review si un signal de configuration
    // Stripe non-standard a été détecté — multi_item_subscriptions n'en
    // fait volontairement pas partie : les subscriptions multi-items sont
    // désormais correctement chiffrées par le moteur (Phase 2.2), ce n'est
    // plus une limitation, juste une donnée de diagnostic.
    if (billingProfile) {
      const flags = { ...billingProfile, invoice_only_accounts: invoiceOnlyAccountsCount }
      const needsReview = flags.invoice_only_accounts > 0
        || flags.metered_subscriptions > 0
        || flags.null_unit_amount_prices > 0
        || flags.multi_currency
        || flags.has_subscription_schedules

      const { error: profileError } = await supabase
        .from('organizations')
        .update({
          billing_profile_flags: flags,
          billing_profile: needsReview ? 'needs_review' : 'standard',
        })
        .eq('id', organizationId)
      if (profileError) {
        console.error(JSON.stringify({
          level: 'error', function_name: 'sync-stripe', organization_id: organizationId,
          message: `Failed to update billing_profile_flags: ${profileError.message}`,
        }))
      }
    }

    await supabase
      .from('organizations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', organizationId)

    // restatement_mode/accounts_restated persistés explicitement (incident
    // 2026-08-04, point A du diagnostic, IMPLEMENTATION_LOG.md) : rien en
    // base ne disait auparavant dans quel mode un run avait tourné — la
    // seule trace était un console.log jamais persisté. Ambiguïté totale au
    // moment de diagnostiquer pourquoi un restatement n'avait rien produit.
    await logger.complete(
      {
        sync_type: syncType,
        created_after: createdAfter,
        restatement_mode: restatementMode,
        ...(restatementMode ? { accounts_restated: restatementAccountsCount ?? 0 } : {}),
      },
      writeErrors,
    )

    // Déclencher le scoring après chaque sync (EdgeRuntime.waitUntil garantit l'exécution)
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    if (supabaseUrl && serviceKey) {
      const scorePromise = fetch(`${supabaseUrl}/functions/v1/calculate-scores`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
        body: JSON.stringify({ organization_id: organizationId }),
      }).catch((err) => {
        console.error(JSON.stringify({
          level: 'warn',
          function_name: 'sync-stripe',
          message: `score trigger failed: ${err instanceof Error ? err.message : String(err)}`,
        }))
      })
      // waitUntil empêche Deno de terminer la fonction avant la fin du fetch background
      EdgeRuntime.waitUntil(scorePromise)
    }

    return jsonResponse({
      success: true,
      organization_id: organizationId,
      sync_type: syncType,
      restatement_mode: restatementMode,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'sync-stripe',
      organization_id: organizationId,
      message: msg,
    }))

    const errorType = msg.includes('rate') || msg.includes('429') ? 'rate_limit' : 'api_error'
    await logger.fail(msg, errorType)

    await alertSlack(
      `sync-stripe failed (${syncType}) for org ${organizationId}: ${msg}`,
      { level: 'critical' },
    )

    return errorResponse(`Sync failed: ${msg}`, 500)
  } finally {
    await releaseCronLock(supabase, lockName)
    if (restatementMode) {
      await releaseCronLock(supabase, restatementLockName)
    }
  }
})
