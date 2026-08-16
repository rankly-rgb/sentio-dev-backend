// ============================================================
// Edge Function : stripe-billing-webhook
// Chantier C — reçoit les événements de l'abonnement Sentio
// (compte Stripe de Sentio elle-même, PAS le compte client connecté
// en OAuth — voir stripe-webhook pour celui-là). Met à jour
// organizations.plan_type suite à un upgrade/downgrade/annulation.
//
// Distinct de stripe-webhook : celui-ci route les events par
// stripe_account_id (Connect, multi-comptes clients) ; ici l'org est
// résolue via client_reference_id / metadata.organization_id posés au
// moment de la création de la Checkout Session
// (stripe-billing-checkout), pas de résolution par compte connecté.
//
// Secret dédié STRIPE_BILLING_WEBHOOK_SECRET — distinct de
// STRIPE_WEBHOOK_SECRET (webhooks clients), signing secrets non
// interchangeables entre les deux endpoints Stripe.
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { alertSlack } from '../_shared/slack-alert.ts'
import { verifyStripeSignature } from '../_shared/stripe-signature.ts'
import { findTierByStripePriceId, isSubscriptionTierKey, type SubscriptionTierKey } from '../_shared/subscription-tiers.ts'
import { withSentry } from '../_shared/sentry.ts'

interface StripeEvent {
  id: string
  type: string
  created: number
  data: { object: Record<string, unknown> }
}

/**
 * UPDATE conditionnel atomique — jamais de lecture préalable de
 * billing_event_at (pas de fenêtre TOCTOU). Un événement Stripe re-délivré
 * en retard ou hors ordre (retry réseau, resend manuel Dashboard Stripe)
 * ne doit jamais écraser un plan_type plus récent — même mécanisme que
 * last_event_created_at dans stripe-webhook/index.ts, appliqué ici à
 * organizations.billing_event_at (migration 20260813000001).
 */
async function updatePlanType(
  supabase: SupabaseClient,
  organizationId: string,
  tier: SubscriptionTierKey,
  eventCreatedIso: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('organizations')
    .update({ plan_type: tier, billing_event_at: eventCreatedIso })
    .eq('id', organizationId)
    .or(`billing_event_at.is.null,billing_event_at.lt.${eventCreatedIso}`)
    .select('id')

  if (error) {
    console.error(JSON.stringify({
      level: 'error', function_name: 'stripe-billing-webhook', organization_id: organizationId,
      message: `Failed to update plan_type to ${tier}: ${error.message}`,
    }))
    throw error
  }

  if (!data || data.length === 0) {
    console.log(JSON.stringify({
      level: 'info', function_name: 'stripe-billing-webhook', organization_id: organizationId,
      message: `plan_type update to ${tier} skipped — event.created (${eventCreatedIso}) not newer than the last applied billing_event_at (stale or out-of-order replay)`,
    }))
    return
  }

  console.log(JSON.stringify({
    level: 'info', function_name: 'stripe-billing-webhook', organization_id: organizationId,
    message: `plan_type updated to ${tier}`,
  }))
}

function resolveOrgIdAndTier(
  obj: Record<string, unknown>,
): { organizationId: string | null; tier: SubscriptionTierKey | null } {
  const metadata = (obj.metadata as Record<string, string> | null) ?? null
  const organizationId = (obj.client_reference_id as string | undefined) ?? metadata?.organization_id ?? null
  const metaTier = metadata?.tier
  const tier = isSubscriptionTierKey(metaTier) ? metaTier : null
  return { organizationId, tier }
}

async function handleCheckoutCompleted(supabase: SupabaseClient, obj: Record<string, unknown>, eventCreatedIso: string): Promise<void> {
  const { organizationId, tier } = resolveOrgIdAndTier(obj)
  if (!organizationId || !tier) {
    console.warn(JSON.stringify({
      level: 'warn', function_name: 'stripe-billing-webhook',
      message: 'checkout.session.completed missing organization_id or tier metadata — cannot update plan_type',
    }))
    return
  }
  await updatePlanType(supabase, organizationId, tier, eventCreatedIso)
}

async function handleSubscriptionUpdated(supabase: SupabaseClient, obj: Record<string, unknown>, eventCreatedIso: string): Promise<void> {
  const { organizationId, tier: metaTier } = resolveOrgIdAndTier(obj)
  if (!organizationId) {
    console.warn(JSON.stringify({
      level: 'warn', function_name: 'stripe-billing-webhook',
      message: 'customer.subscription.updated missing organization_id metadata',
    }))
    return
  }

  const status = obj.status as string | undefined
  if (status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired') {
    await updatePlanType(supabase, organizationId, 'free', eventCreatedIso)
    return
  }

  // Résout le tier réel depuis le price ID de la subscription (source de
  // vérité si un changement de plan a eu lieu côté Stripe sans repasser
  // par metadata.tier, ex: customer portal) — sinon fallback metadata.
  const items = (obj.items as { data?: Array<{ price?: { id?: string } }> } | undefined)?.data ?? []
  const priceId = items[0]?.price?.id
  const resolvedTier = priceId ? findTierByStripePriceId(priceId)?.key : null

  await updatePlanType(supabase, organizationId, resolvedTier ?? metaTier ?? 'free', eventCreatedIso)
}

async function handleSubscriptionDeleted(supabase: SupabaseClient, obj: Record<string, unknown>, eventCreatedIso: string): Promise<void> {
  const { organizationId } = resolveOrgIdAndTier(obj)
  if (!organizationId) return
  await updatePlanType(supabase, organizationId, 'free', eventCreatedIso)
}

Deno.serve(withSentry('stripe-billing-webhook', async (req: Request): Promise<Response> => {
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

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const webhookSecret = Deno.env.get('STRIPE_BILLING_WEBHOOK_SECRET')
  if (!webhookSecret) {
    console.error('[stripe-billing-webhook] STRIPE_BILLING_WEBHOOK_SECRET not configured')
    return errorResponse('Server misconfigured', 500)
  }

  const rawBody = new Uint8Array(await req.arrayBuffer())
  const signatureHeader = req.headers.get('stripe-signature')

  const isValid = await verifyStripeSignature(rawBody, signatureHeader, webhookSecret)
  if (!isValid) {
    console.warn('[stripe-billing-webhook] Invalid signature')
    return errorResponse('Invalid signature', 401)
  }

  let event: StripeEvent
  try {
    event = JSON.parse(new TextDecoder().decode(rawBody)) as StripeEvent
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  let supabase: SupabaseClient
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'stripe-billing-webhook', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  // event.created (secondes epoch Stripe) — jamais la date de traitement,
  // c'est ce qui alimente la garde anti-désordre de updatePlanType().
  const eventCreatedIso = new Date(event.created * 1000).toISOString()

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(supabase, event.data.object, eventCreatedIso)
        break
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(supabase, event.data.object, eventCreatedIso)
        break
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(supabase, event.data.object, eventCreatedIso)
        break
      default:
        // Event non routé — 200 immédiat, pas un échec.
        break
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({
      level: 'error', function_name: 'stripe-billing-webhook', event_type: event.type, event_id: event.id,
      message: msg,
    }))
    await alertSlack(`stripe-billing-webhook: failed to process ${event.type} (${event.id}): ${msg}`, { level: 'critical' })
    return errorResponse('Processing failed', 500)
  }

  return jsonResponse({ received: true })
}))
