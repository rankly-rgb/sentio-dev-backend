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
import { calcSubscriptionMrrCents, classifyMovement, type StripeSubscriptionLike } from '../_shared/mrr-engine.ts'

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

  // Résoudre l'account via le customer
  const { data: accountRow } = await supabase
    .from('accounts')
    .select('id, mrr_cents')
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

  // accountRow.mrr_cents a été lu AVANT toute écriture de ce handler (TOCTOU
  // fix déjà en place) — c'est le snapshot "previous" au niveau compte.
  const prevAccountMrr = accountRow.mrr_cents ?? 0

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

  // Aggregate MRR from ALL billable subscriptions for this account (pas
  // seulement la subscription de cet event, pour gérer les comptes
  // multi-subscriptions). past_due/unpaid inclus (docs/openspec.md §5) : un
  // compte délinquant reste compté, jamais mis à zéro silencieusement.
  const { data: accountSubs } = await supabase
    .from('subscriptions')
    .select('mrr_cents, status')
    .eq('account_id', accountRow.id)
    .in('status', ['active', 'trialing', 'past_due', 'unpaid'])

  const newAccountMrr = (accountSubs ?? []).reduce(
    (sum: number, s: { mrr_cents: number }) => sum + (s.mrr_cents ?? 0), 0,
  )
  // mrr_status au niveau compte : cette subscription seule est vérifiée ici
  // (calcSubscriptionMrrCents détecte déjà metered/unit_amount null sans
  // contexte org) — la détection de devise minoritaire nécessite un vote
  // majoritaire à l'échelle de l'organisation, hors de portée d'un event
  // unitaire : elle est recalculée au prochain sync-stripe quotidien
  // (docs/openspec.md §9).
  const newAccountMrrStatus: 'ok' | 'unavailable' = mrrResult.mrr_status === 'unavailable' ? 'unavailable' : 'ok'

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
    previous: { mrr_cents: prevAccountMrr, mrr_status: 'ok' },
    current: { mrr_cents: newAccountMrr, mrr_status: newAccountMrrStatus },
    hasPriorChurnMovement: priorChurnRow !== null,
  })

  if (movement) {
    const { error: mvtError } = await supabase
      .from('mrr_movements')
      .insert({
        organization_id: organizationId,
        account_id: accountRow.id,
        movement_type: movement.movement_type,
        amount_cents: movement.amount_cents,
        movement_date: new Date().toISOString().split('T')[0],
        stripe_event_id: event.id,
      })

    if (!mvtError) {
      logger.increment('movements_processed')
    } else if (mvtError.code === '23505') {
      // Collision sur la contrainte unique (stripe_event_id) — rejeu légitime
      // du même event Stripe, pas une erreur (Phase 2.6 pour le traitement
      // complet de l'idempotence webhook).
      console.log(JSON.stringify({
        level: 'info', function_name: 'stripe-webhook', event_id: event.id,
        message: 'mrr_movements insert skipped: duplicate stripe_event_id (legitimate replay)',
      }))
    } else {
      console.error(JSON.stringify({
        level: 'error', function_name: 'stripe-webhook', event_id: event.id,
        message: `mrr_movements insert failed: ${mvtError.message}`,
      }))
    }
  }

  await supabase
    .from('accounts')
    .update({
      mrr_cents: newAccountMrr,
      arr_cents: newAccountMrr * 12,
      last_stripe_sync_at: new Date().toISOString(),
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

  // Même logique que sync-stripe : propage la devise du compte Stripe
  // connecté vers organizations.currency dès la première invoice reçue
  // en temps réel, pas seulement lors du sync quotidien.
  await supabase
    .from('organizations')
    .update({ currency: invoiceCurrency })
    .eq('id', organizationId)

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

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'stripe-webhook', message: msg }))
    return jsonResponse({ received: true, error: 'server_configuration_error' })
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
      case 'invoice.paid':
      case 'invoice.voided':
        await handleInvoiceEvent(supabase, organizationId, event, logger)
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
