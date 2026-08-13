// ============================================================
// Edge Function : stripe-webhook
// Reçoit les événements Stripe, vérifie la signature HMAC,
// route chaque event vers le handler approprié et persiste
// les données dans Supabase. Réponse < 5s garantie.
// ============================================================
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { DataSyncLogger } from '../_shared/data-sync-logger.ts'
import { writeToDLQ } from '../_shared/dlq.ts'
import { alertSlack } from '../_shared/slack-alert.ts'
import { verifyStripeSignature } from '../_shared/stripe-signature.ts'
import { calcSubscriptionMrrCents, aggregateAccountMrr, classifyMovement, resolveDelinquentSince, type StripeSubscriptionLike } from '../_shared/mrr-engine.ts'
import { isCronLockHeld } from '../_shared/cron-lock.ts'

// ── Résolution de l'organization depuis stripe_account_id ───
async function resolveOrganization(
  supabase: SupabaseClient,
  stripeAccountId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('organizations')
    .select('id')
    .eq('stripe_account_id', stripeAccountId)
    .maybeSingle()
  return data?.id ?? null
}

// ── Upsert account depuis un objet customer Stripe ──────────
async function upsertAccount(
  supabase: SupabaseClient,
  organizationId: string,
  customer: StripeCustomer,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('accounts')
    .upsert(
      {
        organization_id: organizationId,
        stripe_customer_id: customer.id,
        last_stripe_sync_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,stripe_customer_id', ignoreDuplicates: false },
    )
    .select('id')
    .single()

  if (error) {
    console.error('[stripe-webhook] upsertAccount error:', error.message)
    return null
  }
  return data?.id ?? null
}

// ── Handlers par type d'event ────────────────────────────────

async function handleCustomerCreated(
  supabase: SupabaseClient,
  organizationId: string,
  event: StripeEvent,
  logger: DataSyncLogger,
): Promise<void> {
  const customer = event.data.object as StripeCustomer
  await upsertAccount(supabase, organizationId, customer)
  logger.increment('records_processed')
  logger.increment('records_created')
  logger.increment('accounts_processed')
}

async function handleCustomerUpdated(
  supabase: SupabaseClient,
  organizationId: string,
  event: StripeEvent,
  logger: DataSyncLogger,
): Promise<void> {
  const customer = event.data.object as StripeCustomer
  await upsertAccount(supabase, organizationId, customer)
  logger.increment('records_processed')
  logger.increment('records_updated')
  logger.increment('accounts_processed')
}

async function handleSubscriptionEvent(
  supabase: SupabaseClient,
  organizationId: string,
  event: StripeEvent,
  logger: DataSyncLogger,
): Promise<void> {
  const sub = event.data.object as StripeSubscription

  // Garde d'ordonnancement (docs/openspec.md §10) : Stripe ne garantit pas
  // la livraison des webhooks dans l'ordre. Si un event plus ancien que le
  // dernier déjà appliqué à cette subscription arrive en retard, l'ignorer
  // plutôt que d'écraser un état plus récent avec des données périmées.
  const { data: existingSub } = await supabase
    .from('subscriptions')
    .select('last_event_created_at')
    .eq('stripe_sub_id', sub.id)
    .maybeSingle()

  if (existingSub?.last_event_created_at && event.created) {
    const lastAppliedMs = new Date(existingSub.last_event_created_at).getTime()
    const thisEventMs = event.created * 1000
    if (thisEventMs < lastAppliedMs) {
      console.warn(JSON.stringify({
        level: 'warn', function_name: 'stripe-webhook', event_id: event.id,
        message: `Ignored out-of-order event for subscription ${sub.id}: event.created=${new Date(thisEventMs).toISOString()} older than last applied ${existingSub.last_event_created_at}`,
      }))
      return
    }
  }

  // Résoudre l'account via le customer
  const { data: accountRow } = await supabase
    .from('accounts')
    .select('id, mrr_cents, mrr_status, delinquent_since')
    .eq('organization_id', organizationId)
    .eq('stripe_customer_id', sub.customer)
    .maybeSingle()

  if (!accountRow) {
    console.warn('[stripe-webhook] account not found for customer', sub.customer)
    return
  }

  // calcSubscriptionMrrCents (_shared/mrr-engine.ts) : tous les items,
  // interval_count, remises, trials, metered/null-unit_amount -> unavailable.
  // Seule implémentation autorisée du calcul MRR (docs/openspec.md §13) —
  // plus de formule locale dupliquée avec sync-stripe.
  const mrrResult = calcSubscriptionMrrCents(sub)
  const mrrCents = mrrResult.mrr_cents
  const cancelAt = sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString().split('T')[0] : null
  const canceledAt = sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null
  const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString().split('T')[0] : null
  const contractStart = sub.current_period_start ? new Date(sub.current_period_start * 1000).toISOString() : null
  const contractEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null

  // accountRow.mrr_cents/mrr_status ont été lus AVANT toute écriture de ce
  // handler (TOCTOU fix déjà en place) — c'est le snapshot "previous" au
  // niveau compte.
  const prevAccountMrr = accountRow.mrr_cents ?? 0
  const prevAccountMrrStatus: 'ok' | 'unavailable' = accountRow.mrr_status === 'unavailable' ? 'unavailable' : 'ok'

  // Upsert subscription
  const { error: subError } = await supabase
    .from('subscriptions')
    .upsert(
      {
        organization_id: organizationId,
        account_id: accountRow.id,
        stripe_sub_id: sub.id,
        stripe_price_id: sub.items?.data?.[0]?.price?.id ?? null,
        stripe_product_id: sub.items?.data?.[0]?.price?.product ?? null,
        status: sub.status,
        mrr_cents: mrrCents,
        trial_mrr_cents: mrrResult.trial_mrr_cents,
        mrr_status: mrrResult.mrr_status,
        currency: mrrResult.currency,
        interval_raw: mrrResult.interval_raw,
        interval_count: mrrResult.interval_count,
        quantity: sub.quantity ?? 1,
        trial_end_date: trialEnd,
        cancel_at: cancelAt,
        canceled_at: canceledAt,
        stripe_created_at: sub.created ? new Date(sub.created * 1000).toISOString() : null,
        ...(event.created && { last_event_created_at: new Date(event.created * 1000).toISOString() }),
      },
      { onConflict: 'stripe_sub_id', ignoreDuplicates: false },
    )

  if (subError) {
    console.error('[stripe-webhook] upsert subscription error:', subError.message)
    logger.increment('records_failed')
    return
  }

  logger.increment('subscriptions_processed')

  // Différer la mise à jour du MRR compte / la classification de mouvement
  // si un RESTATEMENT tourne actuellement pour cet org — sync-stripe et
  // stripe-webhook n'ont sinon aucune coordination pendant ce mode (trouvé
  // lors de l'auto-vérification adversariale du 2026-08-04). La subscription
  // elle-même vient d'être upsertée ci-dessus avec l'état Stripe le plus
  // récent (toujours sûr, même calcul que sync-stripe) — seuls le niveau
  // compte (accounts.mrr_cents) et mrr_movements sont sensibles à un
  // "previous" à moitié restaté. Le prochain sync-stripe normal (quotidien)
  // relira cette subscription déjà à jour et régénérera le bon mouvement en
  // comparant au vrai état pré-migration — rien n'est perdu, juste retardé
  // jusqu'à la fin du restatement en cours.
  //
  // Lock dédié `restatement-<org_id>` (distinct du lock partagé
  // `sync-stripe-<org_id>` qui empêche restatement/sync normal de tourner
  // en même temps) — corrigé en revue de merge du 2026-08-04 : vérifier le
  // lock partagé ici aurait aussi différé ce traitement pendant N'IMPORTE
  // QUEL sync-stripe normal (quotidien), pas seulement un restatement,
  // dégradant la latence temps réel des webhooks jusqu'à 24h sans que ce
  // soit voulu ni acté.
  if (await isCronLockHeld(supabase, `restatement-${organizationId}`)) {
    console.log(JSON.stringify({
      level: 'info', function_name: 'stripe-webhook', event_id: event.id, organization_id: organizationId,
      message: `Deferred account-level MRR update / movement classification for subscription ${sub.id}: restatement in progress for this org. Will be reconciled by the next normal sync-stripe run.`,
    }))
    return
  }

  // Aggregate MRR from ALL subscriptions for this account (pas seulement la
  // subscription de cet event, pour gérer les comptes multi-subscriptions).
  // aggregateAccountMrr (_shared/mrr-engine.ts) — même fonction que
  // sync-stripe, reconstruite ici à partir des colonnes persistées
  // (is_delinquent/pending_cancellation ne sont pas stockés par
  // subscription, dérivés de status/cancel_at, seule information
  // équivalente disponible après écriture en base).
  const { data: accountSubs } = await supabase
    .from('subscriptions')
    .select('status, mrr_cents, trial_mrr_cents, mrr_status, currency, cancel_at')
    .eq('account_id', accountRow.id)

  const accountAgg = aggregateAccountMrr(
    (accountSubs ?? []).map((s: {
      status: string
      mrr_cents: number
      trial_mrr_cents: number
      mrr_status: string
      currency: string | null
      cancel_at: string | null
    }) => ({
      status: s.status,
      result: {
        mrr_cents: s.mrr_cents ?? 0,
        trial_mrr_cents: s.trial_mrr_cents ?? 0,
        mrr_status: s.mrr_status === 'unavailable' ? 'unavailable' : 'ok',
        currency: s.currency,
        is_delinquent: s.status === 'past_due' || s.status === 'unpaid',
        pending_cancellation: s.status === 'active' && s.cancel_at !== null,
        interval_raw: '',
        interval_count: 1,
      },
    })),
    // Détection de devise minoritaire hors de portée d'un event unitaire
    // (vote majoritaire à l'échelle de l'org) — recalculée au prochain
    // sync-stripe quotidien (docs/openspec.md §9). null ici = pas de
    // filtre appliqué, toute devise connue est acceptée pour ce compte.
    null,
  )
  const newAccountMrr = accountAgg.mrr_cents
  const newAccountMrrStatus = accountAgg.mrr_status

  // Lot 5 (2026-08-13, #35) — délinquence par durée. DÉCISION AUTONOME :
  // contrairement à sync-stripe (accès à accountSubMeta, la liste complète
  // des subscriptions du compte avec leur contractStart), un event webhook
  // ne porte que la subscription qui l'a déclenché — `subscriptions` ne
  // persiste pas `current_period_start` par ligne (seulement `accounts.
  // contract_start_date`, écrasé par la subscription "primaire"). Candidat
  // limité à CE sub, seulement s'il est lui-même délinquent — sinon `null`
  // (jamais une date fabriquée, S1). resolveDelinquentSince (sticky) fait
  // le reste : si une date a déjà été captée par un run sync-stripe
  // (vision complète), elle est préservée telle quelle par ce chemin.
  const delinquentSinceCandidate = (sub.status === 'past_due' || sub.status === 'unpaid') && sub.current_period_start
    ? new Date(sub.current_period_start * 1000).toISOString().split('T')[0]
    : null
  const delinquentSince = resolveDelinquentSince(
    accountAgg.is_delinquent,
    accountRow.delinquent_since ?? null,
    delinquentSinceCandidate,
  )

  // Classification unique — même fonction pure que sync-stripe
  // (_shared/mrr-engine.ts), garantissant des classifications identiques
  // pour le même événement quel que soit le chemin d'ingestion
  // (AUDIT_LOGIQUE_METIER_STRIPE.md point 11/17). Réactivation détectée au
  // niveau compte (docs/openspec.md §7), pas au niveau objet subscription.
  const { data: priorChurnRow } = await supabase
    .from('mrr_movements')
    .select('id')
    .eq('account_id', accountRow.id)
    .eq('movement_type', 'churn')
    .limit(1)
    .maybeSingle()

  const movement = classifyMovement({
    previous: { mrr_cents: prevAccountMrr, mrr_status: prevAccountMrrStatus },
    current: { mrr_cents: newAccountMrr, mrr_status: newAccountMrrStatus },
    hasPriorChurnMovement: priorChurnRow !== null,
  })

  if (movement) {
    // movement_date = date effective de l'événement Stripe (event.created),
    // jamais la date de traitement (docs/openspec.md §10) — un webhook
    // rattrapé en retard (redémarrage, backlog DLQ) ne doit pas dater le
    // mouvement du jour où il a été rejoué.
    const movementDate = event.created
      ? new Date(event.created * 1000).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0]

    const { error: mvtError } = await supabase
      .from('mrr_movements')
      .insert({
        organization_id: organizationId,
        account_id: accountRow.id,
        movement_type: movement.movement_type,
        amount_cents: movement.amount_cents,
        movement_date: movementDate,
        stripe_event_id: event.id,
        // Event-driven : event.created est toujours une date Stripe réelle
        // pour ce chemin (jamais 'estimated', contrairement au diff batch
        // de sync-stripe pour expansion/contraction — voir Lot 4).
        provenance: 'live',
      })

    if (!mvtError) {
      logger.increment('movements_processed')
    } else if (mvtError.code === '23505') {
      // Collision sur la contrainte unique (stripe_event_id) — rejeu légitime
      // du même event Stripe, pas une erreur.
      console.log(JSON.stringify({
        level: 'info', function_name: 'stripe-webhook', event_id: event.id,
        message: 'mrr_movements insert skipped: duplicate stripe_event_id (legitimate replay)',
      }))
    } else {
      console.error(JSON.stringify({
        level: 'error', function_name: 'stripe-webhook', event_id: event.id,
        message: `mrr_movements insert failed: ${mvtError.message}`,
      }))
      await writeToDLQ(supabase, {
        organization_id: organizationId,
        provider: 'stripe',
        event_type: event.type,
        payload: event,
        error_message: `mrr_movements insert failed: ${mvtError.message}`,
      })
    }
  }

  await supabase
    .from('accounts')
    .update({
      mrr_cents: newAccountMrr,
      arr_cents: newAccountMrr * 12,
      trial_mrr_cents: accountAgg.trial_mrr_cents,
      mrr_status: accountAgg.mrr_status,
      is_delinquent: accountAgg.is_delinquent,
      delinquent_since: delinquentSince,
      pending_cancellation: accountAgg.pending_cancellation,
      is_zero_dollar_active: accountAgg.is_zero_dollar_active,
      // billing_model='subscription' : recevoir un event de subscription
      // implique par définition que ce compte a un objet Subscription
      // Stripe — jamais invoice_only depuis ce chemin (docs/openspec.md §8.2).
      billing_model: 'subscription',
      last_stripe_sync_at: new Date().toISOString(),
      ...(accountAgg.currency !== null && { currency: accountAgg.currency }),
      ...(contractStart !== null && { contract_start_date: contractStart }),
      ...(contractEnd !== null && { contract_end_date: contractEnd }),
    })
    .eq('id', accountRow.id)

  logger.increment('records_processed')
  logger.increment('records_updated')
}

async function handleInvoiceEvent(
  supabase: SupabaseClient,
  organizationId: string,
  event: StripeEvent,
  logger: DataSyncLogger,
): Promise<void> {
  const invoice = event.data.object as StripeInvoice

  // Résoudre l'account
  const { data: accountRow } = await supabase
    .from('accounts')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('stripe_customer_id', invoice.customer)
    .maybeSingle()

  if (!accountRow) return

  // Résoudre la subscription (si présente)
  let subscriptionId: string | null = null
  if (invoice.subscription) {
    const { data: subRow } = await supabase
      .from('subscriptions')
      .select('id')
      .eq('stripe_sub_id', invoice.subscription)
      .maybeSingle()
    subscriptionId = subRow?.id ?? null
  }

  const invoiceDate = invoice.created
    ? new Date(invoice.created * 1000).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0]
  const dueDate = invoice.due_date
    ? new Date(invoice.due_date * 1000).toISOString().split('T')[0]
    : null
  const paidAt = invoice.status_transitions?.paid_at
    ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
    : null

  const invoiceCurrency = invoice.currency ?? 'usd'

  const { error } = await supabase
    .from('invoices')
    .upsert(
      {
        organization_id: organizationId,
        account_id: accountRow.id,
        subscription_id: subscriptionId,
        stripe_invoice_id: invoice.id,
        amount_cents: invoice.amount_due ?? 0,
        currency: invoiceCurrency,
        status: invoice.status ?? 'draft',
        invoice_date: invoiceDate,
        due_date: dueDate,
        paid_at: paidAt,
      },
      { onConflict: 'stripe_invoice_id', ignoreDuplicates: false },
    )

  if (error) {
    console.error('[stripe-webhook] upsert invoice error:', error.message)
    logger.increment('records_failed')
    return
  }

  // organizations.currency n'est plus mis à jour depuis ce chemin (Phase
  // 2.6) : sync-stripe le dérive désormais d'un vote majoritaire sur les
  // subscriptions de l'org (docs/openspec.md §9) — propager la devise
  // d'une seule invoice ici referait flapper la valeur à chaque event pour
  // toute org multi-devises, exactement le bug que le vote majoritaire
  // corrige côté sync-stripe (AUDIT_LOGIQUE_METIER_STRIPE.md point 7).

  logger.increment('records_processed')
  logger.increment('invoices_processed')
  if (event.type === 'invoice.created') {
    logger.increment('records_created')
  } else {
    logger.increment('records_updated')
  }
}

// customer.subscription.trial_will_end — signal informatif uniquement
// (docs/openspec.md §4). Aucune écriture MRR, juste un accusé de réception
// journalisé pour observabilité/futurs insights.
function handleTrialWillEnd(event: StripeEvent, logger: DataSyncLogger): void {
  const trial = event.data.object as StripeTrialWillEnd
  console.log(JSON.stringify({
    level: 'info', function_name: 'stripe-webhook', event_id: event.id,
    message: `trial_will_end received for customer ${trial.customer} (subscription ${trial.id}) — no financial field updated, informational only (docs/openspec.md §4)`,
  }))
  logger.increment('records_processed')
}

// charge.refunded / credit_note.created — met à jour uniquement le statut
// de l'invoice liée (docs/openspec.md §10). Aucun impact rétroactif sur
// mrr_movements/score_history : l'historique n'est jamais réécrit
// silencieusement, seul le ledger d'invoices reste honnête.
async function handleRefundEvent(
  supabase: SupabaseClient,
  organizationId: string,
  event: StripeEvent,
  logger: DataSyncLogger,
): Promise<void> {
  const obj = event.data.object as StripeCharge | StripeCreditNote
  const stripeInvoiceId = obj.invoice
  if (!stripeInvoiceId) {
    // Remboursement/avoir non lié à une invoice (ex. charge one-off) —
    // rien à mettre à jour côté MRR/invoices dans cette itération.
    logger.increment('records_processed')
    return
  }

  const { error } = await supabase
    .from('invoices')
    .update({ status: 'refunded' })
    .eq('organization_id', organizationId)
    .eq('stripe_invoice_id', stripeInvoiceId)

  if (error) {
    console.error(JSON.stringify({
      level: 'error', function_name: 'stripe-webhook', event_id: event.id,
      message: `Failed to mark invoice ${stripeInvoiceId} as refunded: ${error.message}`,
    }))
    logger.increment('records_failed')
    return
  }

  logger.increment('records_processed')
  logger.increment('records_updated')
}

// ── Types Stripe minimalistes ────────────────────────────────
interface StripeEvent {
  id: string
  type: string
  account?: string
  // Timestamp Unix (secondes) de l'événement côté Stripe — garde
  // d'ordonnancement (docs/openspec.md §10) et movement_date effectif,
  // jamais la date de traitement local.
  created?: number
  data: {
    object: unknown
    previous_attributes?: unknown
  }
}

interface StripeCustomer {
  id: string
}

interface StripeSubscription extends StripeSubscriptionLike {
  id: string
  customer: string
  status: string
  quantity?: number
  plan?: { amount: number; interval: string; currency?: string }
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
  current_period_start?: number | null
  current_period_end?: number | null
  created?: number
}

interface StripeInvoice {
  id: string
  customer: string
  subscription?: string
  status?: string
  amount_due?: number
  currency?: string
  created?: number
  due_date?: number | null
  status_transitions?: { paid_at?: number }
}

// charge.refunded / credit_note.created (docs/openspec.md §10) : handlers
// minimaux — mettent à jour uniquement invoices.status, aucun impact
// rétroactif sur mrr_movements/score_history. L'historique n'est jamais
// réécrit silencieusement.
interface StripeCharge {
  id: string
  invoice?: string | null
}

interface StripeCreditNote {
  id: string
  invoice?: string | null
}

// customer.subscription.trial_will_end : aucun champ financier modifié
// (docs/openspec.md §4) — signal informatif pour de futurs insights/
// playbooks, hors périmètre du moteur MRR dans cette itération. Le handler
// se contente d'accuser réception (utile pour l'idempotence/observabilité).
interface StripeTrialWillEnd {
  id: string
  customer: string
}

// ── Handlers routés par event type ──────────────────────────
const ROUTED_EVENTS = new Set([
  'customer.created',
  'customer.updated',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.trial_will_end',
  'invoice.created',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.voided',
  'charge.refunded',
  'credit_note.created',
])

// ── Entrypoint ───────────────────────────────────────────────
Deno.serve(async (req: Request): Promise<Response> => {
  // CORS preflight handling
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, stripe-signature',
      },
    })
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')
  if (!webhookSecret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not configured')
    return errorResponse('Server misconfigured', 500)
  }

  // Client créé avant la vérification de signature (Lot 3, 2026-08-13) :
  // un webhook mal signé doit laisser une trace, pas seulement un
  // console.warn éphémère — voir webhook_receipts, migration
  // 20260813000004. Best-effort : une erreur d'écriture ici ne doit jamais
  // faire échouer la réponse au webhook.
  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'stripe-webhook', message: msg }))
    return jsonResponse({ received: true, error: 'server_configuration_error' })
  }

  const rawBody = new Uint8Array(await req.arrayBuffer())
  const signatureHeader = req.headers.get('stripe-signature')

  const isValid = await verifyStripeSignature(rawBody, signatureHeader, webhookSecret)
  if (!isValid) {
    console.warn('[stripe-webhook] Invalid signature')
    supabase.from('webhook_receipts').insert({ provider: 'stripe', signature_valid: false }).then(
      () => {},
      (err: unknown) => console.error('[stripe-webhook] webhook_receipts insert (invalid signature) failed:', err),
    )
    return errorResponse('Invalid signature', 401)
  }

  let event: StripeEvent
  try {
    event = JSON.parse(new TextDecoder().decode(rawBody)) as StripeEvent
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  // organization_id renseigné plus bas une fois résolu (ligne ~690) — un
  // event valide reçu avant résolution d'org doit déjà apparaître dans le
  // diagnostic global (webhook_receipts.organization_id IS NULL = "reçu
  // mais org non résolue", distinct de "jamais reçu").
  let webhookReceiptId: string | null = null
  try {
    const { data: receiptRow } = await supabase
      .from('webhook_receipts')
      .insert({
        provider: 'stripe',
        signature_valid: true,
        event_type: event.type,
        stripe_event_id: event.id,
      })
      .select('id')
      .single()
    webhookReceiptId = receiptRow?.id ?? null
  } catch (err) {
    console.error('[stripe-webhook] webhook_receipts insert failed:', err instanceof Error ? err.message : String(err))
  }

  // Ignorer les events non routés (répondre 200 immédiatement)
  if (!ROUTED_EVENTS.has(event.type)) {
    return jsonResponse({ received: true, handled: false, type: event.type })
  }

  // Résoudre l'organisation via le compte Stripe connecté
  const stripeAccountId = event.account
  if (!stripeAccountId) {
    // Event depuis le compte Stripe principal — utiliser le premier org disponible
    // (cas webhooks directs sans Connect)
    console.warn('[stripe-webhook] No account in event, trying direct org lookup')
  }

  let organizationId: string | null = null

  if (stripeAccountId) {
    organizationId = await resolveOrganization(supabase, stripeAccountId)
  } else {
    // Fallback : chercher via stripe_customer_id si disponible dans l'objet
    const obj = event.data.object as { customer?: string }
    if (obj.customer) {
      const { data } = await supabase
        .from('accounts')
        .select('organization_id')
        .eq('stripe_customer_id', obj.customer)
        .maybeSingle()
      organizationId = data?.organization_id ?? null
    }
    // Fallback ultime : prendre la première org active (environnement single-tenant ou dev)
    if (!organizationId) {
      const { data } = await supabase
        .from('organizations')
        .select('id')
        .eq('is_active', true)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      organizationId = data?.id ?? null
    }
  }

  if (!organizationId) {
    console.error('[stripe-webhook] Cannot resolve organization for event', event.id)
    // Retourner 200 pour éviter que Stripe ne retry indéfiniment
    return jsonResponse({ received: true, error: 'organization_not_found' })
  }

  // Complète le receipt (Lot 3) avec l'org maintenant résolue — fire and
  // forget, ne doit jamais bloquer/faire échouer le traitement de l'event.
  if (webhookReceiptId) {
    supabase.from('webhook_receipts').update({ organization_id: organizationId }).eq('id', webhookReceiptId).then(
      () => {},
      (err: unknown) => console.error('[stripe-webhook] webhook_receipts org backfill failed:', err),
    )
  }

  // Idempotency check: skip if this event was already processed
  const { data: existingSync } = await supabase
    .from('data_syncs')
    .select('id')
    .eq('webhook_event_id', event.id)
    .eq('sync_status', 'completed')
    .maybeSingle()

  if (existingSync) {
    return jsonResponse({ received: true, handled: false, reason: 'duplicate_event' })
  }

  const logger = new DataSyncLogger({
    supabase,
    organizationId,
    syncSource: 'stripe',
    syncType: 'webhook',
    triggeredBy: 'stripe',
    webhookEventId: event.id,
    isManual: false,
  })

  await logger.start()

  try {
    switch (event.type) {
      case 'customer.created':
        await handleCustomerCreated(supabase, organizationId, event, logger)
        break
      case 'customer.updated':
        await handleCustomerUpdated(supabase, organizationId, event, logger)
        break
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await handleSubscriptionEvent(supabase, organizationId, event, logger)
        break
      case 'invoice.created':
      case 'invoice.voided':
        await handleInvoiceEvent(supabase, organizationId, event, logger)
        break
      case 'invoice.paid':
        await handleInvoiceEvent(supabase, organizationId, event, logger)
        // Fire-and-forget playbook-outcome-detector — ne jamais bloquer le webhook
        // (chantier C — cf. specs/002-playbook-outcome-tracking/contracts/)
        {
          const paidInvoice = event.data.object as { customer?: string }
          if (paidInvoice.customer) {
            const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
            const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
            fetch(`${supabaseUrl}/functions/v1/playbook-outcome-detector`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseKey}`,
              },
              body: JSON.stringify({
                organization_id: organizationId,
                stripe_customer_id: paidInvoice.customer,
              }),
            }).catch((err) => {
              console.warn(JSON.stringify({
                level: 'warn',
                function_name: 'stripe-webhook',
                organization_id: organizationId,
                message: `playbook-outcome-detector fire-and-forget failed: ${err instanceof Error ? err.message : String(err)}`,
              }))
            })
          }
        }
        break
      case 'invoice.payment_failed':
        await handleInvoiceEvent(supabase, organizationId, event, logger)
        // Fire-and-forget playbook-executor — ne jamais bloquer le webhook
        {
          const failedInvoice = event.data.object as { customer?: string }
          if (failedInvoice.customer) {
            const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
            const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
            fetch(`${supabaseUrl}/functions/v1/playbook-executor`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseKey}`,
              },
              body: JSON.stringify({
                organization_id: organizationId,
                stripe_customer_id: failedInvoice.customer,
                trigger_reason: 'invoice_past_due',
              }),
            }).catch((err) => {
              console.warn(JSON.stringify({
                level: 'warn',
                function_name: 'stripe-webhook',
                organization_id: organizationId,
                message: `playbook-executor invoice_past_due fire-and-forget failed: ${err instanceof Error ? err.message : String(err)}`,
              }))
            })
          }
        }
        break
      case 'customer.subscription.trial_will_end':
        handleTrialWillEnd(event, logger)
        break
      case 'charge.refunded':
      case 'credit_note.created':
        await handleRefundEvent(supabase, organizationId, event, logger)
        break
    }

    await logger.complete({ event_type: event.type, event_id: event.id })
    return jsonResponse({ received: true, handled: true, type: event.type })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'stripe-webhook',
      event_id: event.id,
      event_type: event.type,
      organization_id: organizationId,
      message: msg,
    }))
    await logger.fail(msg)

    // Write to dead letter queue for later retry/investigation
    await writeToDLQ(supabase, {
      organization_id: organizationId,
      provider: 'stripe',
      event_type: event.type,
      payload: event,
      error_message: msg,
    })

    await alertSlack(
      `stripe-webhook handler failed for ${event.type} (event ${event.id}): ${msg}`,
      { level: 'warning' },
    )

    // Toujours 200 pour éviter les retries Stripe sur des erreurs internes
    return jsonResponse({ received: true, error: 'internal_error' })
  }
})
