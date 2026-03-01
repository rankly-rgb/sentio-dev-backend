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

const STRIPE_API = 'https://api.stripe.com/v1'

// ── HMAC Stripe signature verification ──────────────────────
async function verifyStripeSignature(
  rawBody: Uint8Array,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) return false

  const parts: Record<string, string> = {}
  for (const item of signatureHeader.split(',')) {
    const [k, v] = item.split('=')
    if (k && v) parts[k] = v
  }

  const timestamp = parts['t']
  const v1 = parts['v1']
  if (!timestamp || !v1) return false

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const payload = encoder.encode(`${timestamp}.`)
  const combined = new Uint8Array(payload.length + rawBody.length)
  combined.set(payload, 0)
  combined.set(rawBody, payload.length)

  const sig = await crypto.subtle.sign('HMAC', key, combined)
  const computed = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  return computed === v1
}

// ── Résolution de l'organization depuis stripe_account_id ───
async function resolveOrganization(
  supabase: SupabaseClient,
  stripeAccountId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('organizations')
    .select('id')
    .eq('stripe_account_id', stripeAccountId)
    .single()
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
  const previousSub = event.data.previous_attributes as Partial<StripeSubscription> | undefined

  // Résoudre l'account via le customer
  const { data: accountRow } = await supabase
    .from('accounts')
    .select('id, mrr_cents')
    .eq('organization_id', organizationId)
    .eq('stripe_customer_id', sub.customer)
    .single()

  if (!accountRow) {
    console.warn('[stripe-webhook] account not found for customer', sub.customer)
    return
  }

  const mrrCents = Math.round((sub.plan?.amount ?? sub.items?.data?.[0]?.price?.unit_amount ?? 0) * (sub.quantity ?? 1) / (sub.plan?.interval === 'year' ? 12 : 1))
  const cancelAt = sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString().split('T')[0] : null
  const canceledAt = sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null
  const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString().split('T')[0] : null

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
        quantity: sub.quantity ?? 1,
        trial_end_date: trialEnd,
        cancel_at: cancelAt,
        canceled_at: canceledAt,
      },
      { onConflict: 'stripe_sub_id', ignoreDuplicates: false },
    )

  if (subError) {
    console.error('[stripe-webhook] upsert subscription error:', subError.message)
    logger.increment('records_failed')
    return
  }

  logger.increment('subscriptions_processed')

  // Calculer le mouvement MRR
  let movementType: string | null = null
  const previousStatus = previousSub?.status
  const currentStatus = sub.status

  if (event.type === 'customer.subscription.created') {
    movementType = 'new'
  } else if (event.type === 'customer.subscription.deleted') {
    movementType = 'churn'
  } else if (event.type === 'customer.subscription.updated') {
    const prevMrr = accountRow.mrr_cents ?? 0
    if (prevMrr === 0 && mrrCents > 0) {
      movementType = previousStatus === 'canceled' ? 'reactivation' : 'new'
    } else if (mrrCents > prevMrr) {
      movementType = 'expansion'
    } else if (mrrCents < prevMrr) {
      movementType = 'contraction'
    }
  }

  if (movementType) {
    const amount = movementType === 'churn'
      ? -(accountRow.mrr_cents ?? 0)
      : movementType === 'contraction'
      ? mrrCents - (accountRow.mrr_cents ?? 0)
      : mrrCents

    const { error: mvtError } = await supabase
      .from('mrr_movements')
      .insert({
        organization_id: organizationId,
        account_id: accountRow.id,
        movement_type: movementType,
        amount_cents: amount,
        movement_date: new Date().toISOString().split('T')[0],
        stripe_event_id: event.id,
      })

    if (!mvtError) {
      logger.increment('movements_processed')
    }
  }

  // Mettre à jour le MRR du compte
  const newMrr = currentStatus === 'active' || currentStatus === 'trialing'
    ? mrrCents
    : 0

  await supabase
    .from('accounts')
    .update({
      mrr_cents: newMrr,
      arr_cents: newMrr * 12,
      last_stripe_sync_at: new Date().toISOString(),
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
    .single()

  if (!accountRow) return

  // Résoudre la subscription (si présente)
  let subscriptionId: string | null = null
  if (invoice.subscription) {
    const { data: subRow } = await supabase
      .from('subscriptions')
      .select('id')
      .eq('stripe_sub_id', invoice.subscription)
      .single()
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

  const { error } = await supabase
    .from('invoices')
    .upsert(
      {
        organization_id: organizationId,
        account_id: accountRow.id,
        subscription_id: subscriptionId,
        stripe_invoice_id: invoice.id,
        amount_cents: invoice.amount_due ?? 0,
        currency: invoice.currency ?? 'eur',
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

  logger.increment('records_processed')
  logger.increment('invoices_processed')
  if (event.type === 'invoice.created') {
    logger.increment('records_created')
  } else {
    logger.increment('records_updated')
  }
}

// ── Types Stripe minimalistes ────────────────────────────────
interface StripeEvent {
  id: string
  type: string
  account?: string
  data: {
    object: unknown
    previous_attributes?: unknown
  }
}

interface StripeCustomer {
  id: string
}

interface StripeSubscription {
  id: string
  customer: string
  status: string
  quantity?: number
  plan?: { amount: number; interval: string }
  items?: { data: Array<{ price: { id: string; unit_amount: number; product: string } }> }
  trial_end?: number | null
  cancel_at?: number | null
  canceled_at?: number | null
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

// ── Handlers routés par event type ──────────────────────────
const ROUTED_EVENTS = new Set([
  'customer.created',
  'customer.updated',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.created',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.voided',
])

// ── Entrypoint ───────────────────────────────────────────────
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')
  if (!webhookSecret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not configured')
    return errorResponse('Server misconfigured', 500)
  }

  const rawBody = new Uint8Array(await req.arrayBuffer())
  const signatureHeader = req.headers.get('stripe-signature')

  const isValid = await verifyStripeSignature(rawBody, signatureHeader, webhookSecret)
  if (!isValid) {
    console.warn('[stripe-webhook] Invalid signature')
    return errorResponse('Invalid signature', 401)
  }

  let event: StripeEvent
  try {
    event = JSON.parse(new TextDecoder().decode(rawBody)) as StripeEvent
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  // Ignorer les events non routés (répondre 200 immédiatement)
  if (!ROUTED_EVENTS.has(event.type)) {
    return jsonResponse({ received: true, handled: false, type: event.type })
  }

  const supabase = createServiceClient()

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
        .single()
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
        .single()
      organizationId = data?.id ?? null
    }
  }

  if (!organizationId) {
    console.error('[stripe-webhook] Cannot resolve organization for event', event.id)
    // Retourner 200 pour éviter que Stripe ne retry indéfiniment
    return jsonResponse({ received: true, error: 'organization_not_found' })
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
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'invoice.voided':
        await handleInvoiceEvent(supabase, organizationId, event, logger)
        break
    }

    await logger.complete({ event_type: event.type, event_id: event.id })
    return jsonResponse({ received: true, handled: true, type: event.type })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[stripe-webhook] Unhandled error:', msg)
    await logger.fail(msg)
    // Toujours 200 pour éviter les retries Stripe sur des erreurs internes
    return jsonResponse({ received: true, error: 'internal_error' })
  }
})
