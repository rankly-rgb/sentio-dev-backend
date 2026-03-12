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
import { getVaultSecret } from '../_shared/vault.ts'
import { resolveCredentialSource } from '../_shared/credential-helpers.ts'
import { determineSyncMode } from '../_shared/sync-stripe-helpers.ts'

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

// ── Credentials OAuth par org ──────────────────────────────────

interface StripeCredentials {
  apiKey: string
  stripeAccount: string | null // Stripe-Account header pour Connect
}

async function getStripeCredentials(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<StripeCredentials> {
  const { data: integration } = await supabase
    .from('organization_integrations')
    .select('vault_access_token_id, provider_account_id, status, integration_method')
    .eq('organization_id', organizationId)
    .eq('provider', 'stripe')
    .eq('status', 'active')
    .maybeSingle()

  const vaultSecret = integration?.vault_access_token_id
    ? await getVaultSecret(supabase, integration.vault_access_token_id)
    : null

  // resolveCredentialSource throws si integration active + Vault echoue (pas de fallback silencieux)
  const source = resolveCredentialSource(integration, vaultSecret, 'stripe')

  if (source.type === 'oauth') {
    return {
      apiKey: vaultSecret!,
      stripeAccount: source.providerAccountId, // Stripe-Account header pour Connect
    }
  }

  if (source.type === 'api_key') {
    return {
      apiKey: vaultSecret!,
      stripeAccount: null, // Pas de Stripe-Account header — cle directe du compte
    }
  }

  // Fallback global : uniquement si AUCUNE integration OAuth n'existe
  const globalKey = Deno.env.get('STRIPE_SECRET_KEY')
  if (globalKey) {
    console.warn(JSON.stringify({
      level: 'warn',
      function_name: 'sync-stripe',
      message: 'No OAuth integration found — using global STRIPE_SECRET_KEY fallback',
      organization_id: organizationId,
    }))
    return { apiKey: globalKey, stripeAccount: null }
  }

  throw new Error('No Stripe credentials available: no OAuth token and no global key')
}

// ── Helpers Stripe API ────────────────────────────────────────
async function stripeGet<T>(
  path: string,
  apiKey: string,
  params?: Record<string, string>,
  stripeAccount?: string | null,
): Promise<T> {
  const url = new URL(`${STRIPE_API_BASE}${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` }
  if (stripeAccount) {
    headers['Stripe-Account'] = stripeAccount
  }

  return retryWithBackoff(
    () =>
      stripeCircuitBreaker.execute(async () => {
        const resp = await fetchWithTimeout(
          url.toString(),
          { headers },
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
  stripeAccount?: string | null,
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

    const page = await stripeGet<StripeListResponse<T & { id: string }>>(path, apiKey, params, stripeAccount)
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

// ── Sync customers → accounts ─────────────────────────────────
async function syncCustomers(
  supabase: SupabaseClient,
  organizationId: string,
  creds: StripeCredentials,
  logger: DataSyncLogger,
  createdAfter?: number,
): Promise<void> {
  const extraParams: Record<string, string> = {}
  if (createdAfter) extraParams['created[gt]'] = String(createdAfter)

  for await (const customer of paginateStripe<StripeCustomer>('/customers', creds.apiKey, extraParams, logger, creds.stripeAccount)) {
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
// For incremental mode, uses current_period_end[gt] instead of created[gt]
// because created[gt] misses subscription updates and cancellations.
async function syncSubscriptions(
  supabase: SupabaseClient,
  organizationId: string,
  creds: StripeCredentials,
  logger: DataSyncLogger,
  subscriptionCursor?: number,
): Promise<void> {
  const extraParams: Record<string, string> = { status: 'all' }
  if (subscriptionCursor) extraParams['current_period_end[gt]'] = String(subscriptionCursor)

  // Pre-build stripe_customer_id → account.id Map (eliminates N+1 queries)
  const { data: subSyncAccounts } = await supabase
    .from('accounts')
    .select('id, stripe_customer_id')
    .eq('organization_id', organizationId)

  const customerToAccount = new Map<string, string>()
  for (const a of subSyncAccounts ?? []) {
    if (a.stripe_customer_id) customerToAccount.set(a.stripe_customer_id, a.id)
  }

  // Track per-account metadata from active subs for propagation
  const accountSubMeta = new Map<string, Array<{
    mrrCents: number
    billingInterval: string
    quantity: number
    contractStart: string | null
    contractEnd: string | null
  }>>()

  for await (const sub of paginateStripe<StripeSubscription>('/subscriptions', creds.apiKey, extraParams, logger, creds.stripeAccount)) {
    // Résoudre l'account via la Map pré-construite (O(1) au lieu d'un SELECT)
    const accountId = customerToAccount.get(sub.customer)

    if (!accountId) {
      console.warn('[sync-stripe] account not found for customer', sub.customer)
      logger.increment('records_failed')
      continue
    }

    const accountRow = { id: accountId }

    const mrrCents = calcMrrCents(sub)
    const interval = getSubscriptionInterval(sub)
    const qty = sub.items?.data?.[0]?.quantity ?? sub.quantity ?? 1
    const cancelAt = sub.cancel_at
      ? new Date(sub.cancel_at * 1000).toISOString().split('T')[0]
      : null
    const canceledAt = sub.canceled_at
      ? new Date(sub.canceled_at * 1000).toISOString()
      : null
    const trialEnd = sub.trial_end
      ? new Date(sub.trial_end * 1000).toISOString().split('T')[0]
      : null
    const periodStart = sub.current_period_start
      ? new Date(sub.current_period_start * 1000).toISOString().split('T')[0]
      : null
    const periodEnd = sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString().split('T')[0]
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
          quantity: qty,
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

    // Collect metadata from active subs for account propagation
    if (sub.status === 'active' || sub.status === 'trialing') {
      const subs = accountSubMeta.get(accountRow.id) ?? []
      subs.push({
        mrrCents,
        billingInterval: interval === 'year' ? 'annual' : 'monthly',
        quantity: qty,
        contractStart: periodStart,
        contractEnd: periodEnd,
      })
      accountSubMeta.set(accountRow.id, subs)
    }
  }

  // Aggregate MRR + propagate metadata per account (using pre-built Map)
  const allAccountIds = Array.from(customerToAccount.values())
  for (const acctId of allAccountIds) {
    const subs = accountSubMeta.get(acctId) ?? []
    const totalMrr = subs.reduce((sum: number, s) => sum + s.mrrCents, 0)
    const totalSeats = subs.reduce((sum: number, s) => sum + s.quantity, 0)

    // Use highest-MRR subscription for interval and contract dates
    const primary = subs.length > 0
      ? subs.sort((a, b) => b.mrrCents - a.mrrCents)[0]
      : null

    const updateData: Record<string, unknown> = {
      mrr_cents: totalMrr,
      arr_cents: totalMrr * 12,
      seat_count: totalSeats > 0 ? totalSeats : null,
    }

    if (primary) {
      updateData.billing_interval = primary.billingInterval
      updateData.contract_start_date = primary.contractStart
      updateData.contract_end_date = primary.contractEnd
    }

    const { error: updateErr } = await supabase
      .from('accounts')
      .update(updateData)
      .eq('id', acctId)

    if (updateErr) {
      console.error('[sync-stripe] account MRR update error:', updateErr.message, 'account:', acctId)
      logger.increment('records_failed')
    }
  }
}

// ── Sync invoices ─────────────────────────────────────────────
async function syncInvoices(
  supabase: SupabaseClient,
  organizationId: string,
  creds: StripeCredentials,
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

  for await (const invoice of paginateStripe<StripeInvoice>('/invoices', creds.apiKey, extraParams, logger, creds.stripeAccount)) {
    const accountId = invoiceCustomerMap.get(invoice.customer)

    if (!accountId) {
      logger.increment('records_failed')
      continue
    }

    const subscriptionId = invoice.subscription ? (stripeSubMap.get(invoice.subscription) ?? null) : null

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
          account_id: accountId,
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

  let body: {
    organization_id?: string
    sync_type?: 'incremental' | 'full_sync' | 'initial'
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

  // Résoudre l'organisation — organization_id obligatoire
  const organizationId = body.organization_id
  if (!organizationId) {
    return errorResponse('organization_id is required', 400)
  }

  // Verifier que l'org existe et est active
  const { data: org } = await supabase
    .from('organizations')
    .select('id')
    .eq('id', organizationId)
    .eq('is_active', true)
    .maybeSingle()

  if (!org) {
    return errorResponse('Organization not found or inactive', 404)
  }

  // Recuperer les credentials Stripe (OAuth Vault → fallback env var)
  let creds: StripeCredentials
  try {
    creds = await getStripeCredentials(supabase, organizationId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return errorResponse(`Stripe credentials error: ${msg}`, 500)
  }

  const isManual = body.is_manual ?? false

  // Acquire cron lock BEFORE mode detection to prevent concurrent sync runs
  const lockAcquired = await acquireCronLock(supabase, 'sync-stripe', 300)
  if (!lockAcquired) {
    return errorResponse('Sync already in progress', 409)
  }

  // Determine sync mode: query last successful sync from data_syncs.
  // Auto-detect: if last sync completed within 1 hour → incremental, otherwise full.
  // A manual override via body.sync_type='full_sync' forces a full sync.
  const { data: lastSyncRow } = await supabase
    .from('data_syncs')
    .select('completed_at')
    .eq('sync_source', 'stripe')
    .eq('sync_status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const lastSyncCompletedAt = lastSyncRow?.completed_at
    ? new Date(lastSyncRow.completed_at)
    : null

  const forcedFull = body.sync_type === 'full_sync' || body.sync_type === 'initial'
  const { mode: detectedMode, cursor } = determineSyncMode(lastSyncCompletedAt, new Date())
  const syncMode: 'incremental' | 'full' = forcedFull ? 'full' : detectedMode

  // cursor used for customers + invoices (created[gt])
  // For subscriptions we use current_period_end[gt] to capture updates/cancellations
  const createdAfter = syncMode === 'incremental' ? cursor : undefined

  // Keep syncType for DataSyncLogger compatibility (full_sync vs incremental)
  const syncType = syncMode === 'full' ? 'full_sync' : 'incremental'

  console.log(JSON.stringify({
    level: 'info',
    function_name: 'sync-stripe',
    organization_id: organizationId,
    message: `Starting sync`,
    sync_mode: syncMode,
    cursor,
    last_sync_completed_at: lastSyncRow?.completed_at ?? null,
    is_manual: isManual,
  }))

  const logger = new DataSyncLogger({
    supabase,
    organizationId,
    syncSource: 'stripe',
    syncType,
    triggeredBy: isManual ? 'manual' : 'cron',
    isManual,
  })

  await logger.start()

  try {
    // Sync dans l'ordre : customers → subscriptions → invoices
    // Subscriptions use current_period_end[gt] for incremental (captures updates/cancellations)
    await syncCustomers(supabase, organizationId, creds, logger, createdAfter)
    await syncSubscriptions(supabase, organizationId, creds, logger, createdAfter)
    await syncInvoices(supabase, organizationId, creds, logger, createdAfter)

    // Mettre à jour le timestamp de sync sur l'organisation
    await supabase
      .from('organizations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', organizationId)

    await logger.complete({ sync_mode: syncMode, sync_type: syncType, cursor })

    // Declencher le scoring automatiquement apres un sync reussi (fire-and-forget)
    triggerScoring(organizationId)

    return jsonResponse({
      success: true,
      organization_id: organizationId,
      sync_mode: syncMode,
      sync_type: syncType,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'sync-stripe',
      organization_id: organizationId,
      sync_mode: syncMode,
      message: msg,
    }))

    const errorType = msg.includes('rate') || msg.includes('429') ? 'rate_limit' : 'api_error'
    await logger.fail(msg, errorType)

    await alertSlack(
      `sync-stripe failed (${syncMode}) for org ${organizationId}: ${msg}`,
      { level: 'critical' },
    )

    return errorResponse(`Sync failed: ${msg}`, 500)
  } finally {
    await releaseCronLock(supabase, 'sync-stripe')
  }
})

// ── Trigger scoring after sync ──────────────────────────────
function triggerScoring(orgId: string): void {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) return

  fetch(`${supabaseUrl}/functions/v1/calculate-scores`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({ organization_id: orgId }),
  })
    .then((resp) => {
      console.log(JSON.stringify({
        level: resp.ok ? 'info' : 'warn',
        function_name: 'sync-stripe',
        message: `calculate-scores trigger ${resp.ok ? 'succeeded' : 'failed'} (${resp.status})`,
        organization_id: orgId,
      }))
    })
    .catch((err) => {
      console.warn(JSON.stringify({
        level: 'warn',
        function_name: 'sync-stripe',
        message: `calculate-scores trigger error: ${err.message}`,
        organization_id: orgId,
      }))
    })
}
