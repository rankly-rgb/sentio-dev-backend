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
      price: { id: string; unit_amount: number; product: string }
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

// ── Calcul MRR depuis subscription ───────────────────────────
function calcMrrCents(sub: StripeSubscription): number {
  const item = sub.items?.data?.[0]
  const amount = item?.price?.unit_amount ?? sub.plan?.amount ?? 0
  const qty = item?.quantity ?? sub.quantity ?? 1
  const interval = sub.plan?.interval ?? (item?.price as Record<string, unknown> & { recurring?: { interval?: string } })?.recurring?.interval ?? 'month'
  return Math.round((amount * qty) / (interval === 'year' ? 12 : 1))
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

  for await (const customer of paginateStripe<StripeCustomer>('/customers', apiKey, extraParams, logger)) {
    const { error } = await supabase
      .from('accounts')
      .upsert(
        {
          organization_id: organizationId,
          stripe_customer_id: customer.id,
          last_stripe_sync_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id,stripe_customer_id', ignoreDuplicates: false },
      )

    if (error) {
      console.error('[sync-stripe] account upsert error:', error.message)
      logger.increment('records_failed')
    } else {
      logger.increment('records_processed')
      logger.increment('accounts_processed')
    }
  }
}

// ── Sync subscriptions ────────────────────────────────────────
async function syncSubscriptions(
  supabase: SupabaseClient,
  organizationId: string,
  apiKey: string,
  logger: DataSyncLogger,
  createdAfter?: number,
): Promise<void> {
  const extraParams: Record<string, string> = { status: 'all' }
  if (createdAfter) extraParams['created[gt]'] = String(createdAfter)

  for await (const sub of paginateStripe<StripeSubscription>('/subscriptions', apiKey, extraParams, logger)) {
    // Résoudre l'account
    const { data: accountRow } = await supabase
      .from('accounts')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('stripe_customer_id', sub.customer)
      .single()

    if (!accountRow) {
      console.warn('[sync-stripe] account not found for customer', sub.customer)
      logger.increment('records_failed')
      continue
    }

    const mrrCents = calcMrrCents(sub)
    const cancelAt = sub.cancel_at
      ? new Date(sub.cancel_at * 1000).toISOString().split('T')[0]
      : null
    const canceledAt = sub.canceled_at
      ? new Date(sub.canceled_at * 1000).toISOString()
      : null
    const trialEnd = sub.trial_end
      ? new Date(sub.trial_end * 1000).toISOString().split('T')[0]
      : null

    const { error } = await supabase
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
          quantity: sub.quantity ?? 1,
          trial_end_date: trialEnd,
          cancel_at: cancelAt,
          canceled_at: canceledAt,
        },
        { onConflict: 'stripe_sub_id', ignoreDuplicates: false },
      )

    if (error) {
      console.error('[sync-stripe] subscription upsert error:', error.message)
      logger.increment('records_failed')
      continue
    }

    logger.increment('records_processed')
    logger.increment('subscriptions_processed')
  }

  // Aggregate MRR across all active subscriptions per account
  const { data: orgAccounts } = await supabase
    .from('accounts')
    .select('id')
    .eq('organization_id', organizationId)

  for (const acct of orgAccounts ?? []) {
    const { data: activeSubs } = await supabase
      .from('subscriptions')
      .select('mrr_cents')
      .eq('account_id', acct.id)
      .in('status', ['active', 'trialing'])

    const totalMrr = (activeSubs ?? []).reduce((sum, s) => sum + (s.mrr_cents ?? 0), 0)
    await supabase
      .from('accounts')
      .update({ mrr_cents: totalMrr, arr_cents: totalMrr * 12 })
      .eq('id', acct.id)
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

  for await (const invoice of paginateStripe<StripeInvoice>('/invoices', apiKey, extraParams, logger)) {
    const { data: accountRow } = await supabase
      .from('accounts')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('stripe_customer_id', invoice.customer)
      .single()

    if (!accountRow) {
      logger.increment('records_failed')
      continue
    }

    let subscriptionId: string | null = null
    if (invoice.subscription) {
      const { data: subRow } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('stripe_sub_id', invoice.subscription)
        .single()
      subscriptionId = subRow?.id ?? null
    }

    const invoiceDate = new Date(invoice.created * 1000).toISOString().split('T')[0]
    const dueDate = invoice.due_date
      ? new Date(invoice.due_date * 1000).toISOString().split('T')[0]
      : null
    const paidAt = invoice.status_transitions?.paid_at
      ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
      : null

    const { error } = await supabase
      .from('invoices')
      .upsert(
        {
          organization_id: organizationId,
          account_id: accountRow.id,
          subscription_id: subscriptionId,
          stripe_invoice_id: invoice.id,
          amount_cents: invoice.amount_due,
          currency: invoice.currency,
          status: invoice.status,
          invoice_date: invoiceDate,
          due_date: dueDate,
          paid_at: paidAt,
        },
        { onConflict: 'stripe_invoice_id', ignoreDuplicates: false },
      )

    if (error) {
      console.error('[sync-stripe] invoice upsert error:', error.message)
      logger.increment('records_failed')
    } else {
      logger.increment('records_processed')
      logger.increment('invoices_processed')
    }
  }
}

// ── Entrypoint ───────────────────────────────────────────────
Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  const apiKey = Deno.env.get('STRIPE_SECRET_KEY')
  if (!apiKey) {
    return errorResponse('STRIPE_SECRET_KEY not configured', 500)
  }

  let body: {
    organization_id?: string
    sync_type?: 'incremental' | 'full_sync'
    created_after?: number
    is_manual?: boolean
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

  // Résoudre l'organisation
  let organizationId = body.organization_id
  if (!organizationId) {
    const { data } = await supabase
      .from('organizations')
      .select('id')
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .single()
    organizationId = data?.id
  }

  if (!organizationId) {
    return errorResponse('No active organization found', 404)
  }

  const syncType = body.sync_type ?? 'incremental'
  const isManual = body.is_manual ?? false

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
      .single()

    if (lastSync?.completed_at) {
      createdAfter = Math.floor(new Date(lastSync.completed_at).getTime() / 1000) - 3600 // -1h de marge
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

  // Acquire cron lock to prevent concurrent sync runs
  const lockAcquired = await acquireCronLock(supabase, 'sync-stripe', 300)
  if (!lockAcquired) {
    return errorResponse('Sync already in progress', 409)
  }

  await logger.start()

  try {
    // Sync dans l'ordre : customers → subscriptions → invoices
    await syncCustomers(supabase, organizationId, apiKey, logger, createdAfter)
    await syncSubscriptions(supabase, organizationId, apiKey, logger, createdAfter)
    await syncInvoices(supabase, organizationId, apiKey, logger, createdAfter)

    // Mettre à jour le timestamp de sync sur l'organisation
    await supabase
      .from('organizations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', organizationId)

    await logger.complete({ sync_type: syncType, created_after: createdAfter })

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
    await releaseCronLock(supabase, 'sync-stripe')
  }
})
