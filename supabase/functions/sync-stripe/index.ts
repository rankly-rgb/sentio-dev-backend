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
const STRIPE_TIMEOUT_MS = 8000
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
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 15000,
      jitter: true,
      retryOn: (err) => {
        const msg = err instanceof Error ? err.message : String(err)
        // Retry on timeout, 5xx, rate limits — not on 4xx client errors
        return msg.includes('timed out') || msg.includes('→ 5') || msg.includes('→ 429')
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
      console.error(`[sync-stripe] batch upsert ${table} error:`, error.message)
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
    rows.push({
      organization_id: organizationId,
      stripe_customer_id: customer.id,
      last_stripe_sync_at: syncedAt,
    })
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
  const { data: subSyncAccounts } = await supabase
    .from('accounts')
    .select('id, stripe_customer_id')
    .eq('organization_id', organizationId)

  const customerToAccount = new Map<string, string>()
  for (const a of subSyncAccounts ?? []) {
    if (a.stripe_customer_id) customerToAccount.set(a.stripe_customer_id, a.id)
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
  let skipped = 0

  for await (const invoice of paginateStripe<StripeInvoice>('/invoices', apiKey, extraParams, logger)) {
    const accountId = invoiceCustomerMap.get(invoice.customer)
    if (!accountId) {
      skipped++
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
  logger.increment('records_failed', failed + skipped)
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

  // Résoudre l'organisation + lire la clé Stripe per-org
  let organizationId = body.organization_id
  let orgStripeKey: string | null = null

  console.log(JSON.stringify({ level: 'info', function_name: 'sync-stripe', step: '1_org_resolve', organization_id_from_body: organizationId ?? null }))

  if (organizationId) {
    const { data: orgData, error: orgErr } = await supabase
      .from('organizations')
      .select('stripe_api_key')
      .eq('id', organizationId)
      .maybeSingle()
    if (orgErr) console.error(JSON.stringify({ level: 'error', function_name: 'sync-stripe', step: '1_org_query', error: orgErr.message }))
    orgStripeKey = orgData?.stripe_api_key ?? null
  } else {
    const { data: orgData, error: orgErr } = await supabase
      .from('organizations')
      .select('id, stripe_api_key')
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (orgErr) console.error(JSON.stringify({ level: 'error', function_name: 'sync-stripe', step: '1_org_fallback_query', error: orgErr.message }))
    organizationId = orgData?.id
    orgStripeKey = orgData?.stripe_api_key ?? null
  }

  console.log(JSON.stringify({ level: 'info', function_name: 'sync-stripe', step: '2_org_resolved', organization_id: organizationId ?? null, has_org_key: orgStripeKey !== null }))

  if (!organizationId) {
    return errorResponse('No active organization found', 404)
  }

  // Clé Stripe : priorité org > variable d'env globale
  const apiKey = orgStripeKey ?? Deno.env.get('STRIPE_SECRET_KEY')
  if (!apiKey) {
    return errorResponse('Clé Stripe non configurée. Ajoutez votre clé dans Intégrations → Stripe.', 500)
  }

  const syncType = body.sync_type ?? 'incremental'
  const isManual = body.is_manual ?? false
  const triggeredBy = body.triggered_by ?? 'cron'
  const isOnboarding = triggeredBy === 'onboarding'

  console.log(JSON.stringify({ level: 'info', function_name: 'sync-stripe', step: '3_key_ok', sync_type: syncType }))

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
      // Guard against future timestamps or invalid dates
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

  // Lock per-org pour les syncs onboarding, lock global pour les crons
  const lockName = isOnboarding ? `sync-stripe-${organizationId}` : 'sync-stripe'
  console.log(JSON.stringify({ level: 'info', function_name: 'sync-stripe', step: '4_acquiring_lock', lock_name: lockName }))
  const lockAcquired = await acquireCronLock(supabase, lockName, 300)
  console.log(JSON.stringify({ level: 'info', function_name: 'sync-stripe', step: '5_lock_result', acquired: lockAcquired }))
  if (!lockAcquired) {
    return errorResponse('Sync already in progress', 409)
  }

  console.log(JSON.stringify({ level: 'info', function_name: 'sync-stripe', step: '6_logger_start' }))
  await logger.start()
  console.log(JSON.stringify({ level: 'info', function_name: 'sync-stripe', step: '7_sync_begin' }))

  try {
    // Sync dans l'ordre : customers → subscriptions (always full) → invoices
    await syncCustomers(supabase, organizationId, apiKey, logger, createdAfter)
    await syncSubscriptions(supabase, organizationId, apiKey, logger)
    await syncInvoices(supabase, organizationId, apiKey, logger, createdAfter)

    // Mettre à jour le timestamp de sync sur l'organisation
    await supabase
      .from('organizations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', organizationId)

    await logger.complete({ sync_type: syncType, created_after: createdAfter })

    // Déclencher le scoring automatiquement après un sync onboarding
    if (isOnboarding) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      if (supabaseUrl && serviceKey) {
        fetch(`${supabaseUrl}/functions/v1/calculate-scores`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
          body: JSON.stringify({ organization_id: organizationId }),
        }).catch((err) => {
          console.error(JSON.stringify({
            level: 'warn',
            function_name: 'sync-stripe',
            message: `onboarding score trigger failed: ${err instanceof Error ? err.message : String(err)}`,
          }))
        })
      }
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
