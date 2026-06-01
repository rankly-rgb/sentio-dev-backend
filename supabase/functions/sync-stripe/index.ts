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
import { DataSyncLogger } from '../_shared/data-sync-logger.ts'
import { acquireCronLock, releaseCronLock } from '../_shared/cron-lock.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'
import { retryWithBackoff } from '../_shared/retry-with-backoff.ts'
import { CircuitBreaker } from '../_shared/circuit-breaker.ts'
import { alertSlack } from '../_shared/slack-alert.ts'

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

interface StripeSubscription {
  id: string
  customer: string
  status: string
  quantity: number
  plan?: { amount: number; interval: string; id: string; product: string }
  items?: {
    data: Array<{
      price: { id: string; unit_amount: number; product: string; recurring?: { interval: string; interval_count?: number } }
      quantity?: number
    }>
  }
  trial_end?: number | null
  cancel_at?: number | null
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
function getSubscriptionInterval(sub: StripeSubscription): string {
  return sub.plan?.interval ?? sub.items?.data?.[0]?.price?.recurring?.interval ?? 'month'
}

function calcMrrCents(sub: StripeSubscription): number {
  const item = sub.items?.data?.[0]
  const amount = item?.price?.unit_amount ?? sub.plan?.amount ?? 0
  const qty = item?.quantity ?? sub.quantity ?? 1
  const interval = getSubscriptionInterval(sub)
  return Math.round((amount * qty) / (interval === 'year' ? 12 : 1))
}

// ── Helpers batch ─────────────────────────────────────────────
async function batchUpsert<T extends Record<string, unknown>>(
  supabase: SupabaseClient,
  table: string,
  rows: T[],
  onConflict: string,
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

  const { processed, failed } = await batchUpsert(supabase, 'accounts', rows, 'organization_id,stripe_customer_id')
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
): Promise<void> {
  const extraParams: Record<string, string> = { status: 'all' }

  // Pre-build stripe_customer_id → account.id Map (eliminates N+1 queries)
  // + snapshot du MRR actuel pour détecter les mouvements
  const { data: subSyncAccounts } = await supabase
    .from('accounts')
    .select('id, stripe_customer_id, mrr_cents')
    .eq('organization_id', organizationId)

  const customerToAccount = new Map<string, string>()
  const prevMrrByAccount = new Map<string, number>()
  for (const a of subSyncAccounts ?? []) {
    if (a.stripe_customer_id) customerToAccount.set(a.stripe_customer_id, a.id)
    prevMrrByAccount.set(a.id, a.mrr_cents ?? 0)
  }

  // Track per-account metadata from active subs for MRR aggregation
  const accountSubMeta = new Map<string, Array<{
    mrrCents: number
    billingInterval: string
    quantity: number
    contractStart: string | null
    contractEnd: string | null
  }>>()

  // Collect all subscription rows — batch upsert at the end
  const subRows: Record<string, unknown>[] = []

  for await (const sub of paginateStripe<StripeSubscription>('/subscriptions', apiKey, extraParams, logger)) {
    const accountId = customerToAccount.get(sub.customer)
    if (!accountId) {
      logger.increment('records_failed')
      continue
    }

    const mrrCents = calcMrrCents(sub)
    const interval = getSubscriptionInterval(sub)
    const qty = sub.items?.data?.[0]?.quantity ?? sub.quantity ?? 1

    subRows.push({
      organization_id: organizationId,
      account_id: accountId,
      stripe_sub_id: sub.id,
      stripe_price_id: sub.items?.data?.[0]?.price?.id ?? null,
      stripe_product_id: sub.items?.data?.[0]?.price?.product ?? null,
      status: sub.status,
      mrr_cents: mrrCents,
      quantity: qty,
      trial_end_date: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString().split('T')[0] : null,
      cancel_at: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString().split('T')[0] : null,
      canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
    })

    // Collect metadata from active subs for account MRR propagation
    if (sub.status === 'active' || sub.status === 'trialing') {
      const periodStart = sub.current_period_start
        ? new Date(sub.current_period_start * 1000).toISOString().split('T')[0]
        : null
      const periodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString().split('T')[0]
        : null
      const list = accountSubMeta.get(accountId) ?? []
      list.push({
        mrrCents,
        billingInterval: interval === 'year' ? 'annual' : 'monthly',
        quantity: qty,
        contractStart: periodStart,
        contractEnd: periodEnd,
      })
      accountSubMeta.set(accountId, list)
    }
  }

  // Phase 1 : batch upsert subscriptions
  const { processed: subOk, failed: subFail } = await batchUpsert(supabase, 'subscriptions', subRows, 'stripe_sub_id')
  logger.increment('records_processed', subOk)
  logger.increment('subscriptions_processed', subOk)
  logger.increment('records_failed', subFail)

  // Phase 2 : batch upsert account MRR aggregates
  // upsert on accounts with onConflict='id' to batch-update all in one round-trip per 500 rows
  const accountUpdateRows: Record<string, unknown>[] = []
  for (const acctId of customerToAccount.values()) {
    const subs = accountSubMeta.get(acctId) ?? []
    const totalMrr = subs.reduce((sum, s) => sum + s.mrrCents, 0)
    const totalSeats = subs.reduce((sum, s) => sum + s.quantity, 0)
    const primary = subs.length > 0 ? subs.sort((a, b) => b.mrrCents - a.mrrCents)[0] : null

    const row: Record<string, unknown> = {
      id: acctId,
      organization_id: organizationId,
      mrr_cents: totalMrr,
      arr_cents: totalMrr * 12,
      seat_count: totalSeats > 0 ? totalSeats : null,
    }
    if (primary) {
      row.billing_interval = primary.billingInterval
      row.contract_start_date = primary.contractStart
      row.contract_end_date = primary.contractEnd
    }
    accountUpdateRows.push(row)
  }

  const { failed: acctFail } = await batchUpsert(supabase, 'accounts', accountUpdateRows, 'id')
  logger.increment('records_failed', acctFail)

  // Phase 3 : générer les mrr_movements par comparaison avant/après
  // Idempotent grâce à l'index unique (org_id, account_id, movement_date, movement_type) WHERE stripe_event_id IS NULL
  const today = new Date().toISOString().split('T')[0]
  const movementRows: Record<string, unknown>[] = []

  for (const acctId of customerToAccount.values()) {
    const subs = accountSubMeta.get(acctId) ?? []
    const newMrr = subs.reduce((sum, s) => sum + s.mrrCents, 0)
    const prevMrr = prevMrrByAccount.get(acctId) ?? 0

    let movementType: string | null = null
    let amount = 0

    if (prevMrr === 0 && newMrr > 0) {
      movementType = 'new'; amount = newMrr
    } else if (newMrr > prevMrr && prevMrr > 0) {
      movementType = 'expansion'; amount = newMrr - prevMrr
    } else if (newMrr > 0 && newMrr < prevMrr) {
      movementType = 'contraction'; amount = newMrr - prevMrr  // valeur négative
    } else if (newMrr === 0 && prevMrr > 0) {
      movementType = 'churn'; amount = -prevMrr
    }

    if (movementType) {
      movementRows.push({
        organization_id: organizationId,
        account_id: acctId,
        movement_type: movementType,
        amount_cents: amount,
        movement_date: today,
        stripe_event_id: null,
      })
    }
  }

  if (movementRows.length > 0) {
    const { error: mvtErr } = await supabase
      .from('mrr_movements')
      .upsert(movementRows, {
        onConflict: 'organization_id,account_id,movement_date,movement_type',
        ignoreDuplicates: true,
      })
    if (mvtErr) {
      console.error(JSON.stringify({
        level: 'warn',
        function_name: 'sync-stripe',
        message: `mrr_movements upsert failed: ${mvtErr.message}`,
      }))
    } else {
      logger.increment('movements_processed', movementRows.length)
    }
  }
}

// ── Sync invoices ─────────────────────────────────────────────
async function syncInvoices(
  supabase: SupabaseClient,
  organizationId: string,
  apiKey: string,
  logger: DataSyncLogger,
  createdAfter?: number,
): Promise<void> {
  const extraParams: Record<string, string> = {}
  if (createdAfter) extraParams['created[gt]'] = String(createdAfter)

  // Pre-build lookup Maps (eliminates N+1 queries)
  const [acctResult, subResult] = await Promise.all([
    supabase.from('accounts').select('id, stripe_customer_id').eq('organization_id', organizationId),
    supabase.from('subscriptions').select('id, stripe_sub_id').eq('organization_id', organizationId),
  ])

  const invoiceCustomerMap = new Map<string, string>()
  for (const a of acctResult.data ?? []) {
    if (a.stripe_customer_id) invoiceCustomerMap.set(a.stripe_customer_id, a.id)
  }

  const stripeSubMap = new Map<string, string>()
  for (const s of subResult.data ?? []) {
    if (s.stripe_sub_id) stripeSubMap.set(s.stripe_sub_id, s.id)
  }

  const invoiceRows: Record<string, unknown>[] = []
  let orphaned = 0 // invoices for Stripe customers not yet in accounts — not a failure

  for await (const invoice of paginateStripe<StripeInvoice>('/invoices', apiKey, extraParams, logger)) {
    const accountId = invoiceCustomerMap.get(invoice.customer)
    if (!accountId) {
      orphaned++
      continue
    }

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

  const { processed, failed } = await batchUpsert(supabase, 'invoices', invoiceRows, 'stripe_invoice_id')
  logger.increment('records_processed', processed)
  logger.increment('invoices_processed', processed)
  logger.increment('records_failed', failed)
  if (orphaned > 0) {
    console.warn(JSON.stringify({
      level: 'warn', function_name: 'sync-stripe',
      message: `${orphaned} invoices skipped — no matching account (expected during initial sync)`,
    }))
  }
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
          body: JSON.stringify({ organization_id: org.id, sync_type: syncType, triggered_by: triggeredBy }),
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
    return errorResponse('Clé Stripe non configurée. Ajoutez votre clé dans Intégrations → Stripe.', 500)
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

  // Lock toujours per-org (pas de lock global) pour permettre les syncs parallèles
  const lockName = `sync-stripe-${organizationId}`
  const lockAcquired = await acquireCronLock(supabase, lockName, 300)
  if (!lockAcquired) {
    return errorResponse('Sync already in progress for this organization', 409)
  }

  await logger.start()

  try {
    await syncCustomers(supabase, organizationId, apiKey, logger, createdAfter)
    await syncSubscriptions(supabase, organizationId, apiKey, logger)
    await syncInvoices(supabase, organizationId, apiKey, logger, createdAfter)

    await supabase
      .from('organizations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', organizationId)

    await logger.complete({ sync_type: syncType, created_after: createdAfter })

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
  }
})
