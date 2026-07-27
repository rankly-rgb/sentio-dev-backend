// ============================================================
// Edge Function : sentio-billing-webhook
// Webhook DÉDIÉ au compte Stripe Billing DE SENTIO.
//
// ⚠️ SÉPARATION STRICTE (cf. specs/003-pricing-billing-implementation/
// research.md, risque critique) : endpoint, secret de signature et table
// mise à jour sont tous distincts de l'intégration Stripe qui lit les
// données de facturation des CLIENTS de chaque organisation. La
// vérification de signature HMAC ci-dessous est délibérément dupliquée
// (pas importée) pour garantir zéro couplage de code entre les deux
// intégrations, conformément à la gouvernance de ce chantier.
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'

interface StripeEvent {
  id: string
  type: string
  data: { object: Record<string, unknown> }
}

// ── Vérification de signature HMAC (dupliquée intentionnellement) ──

async function verifySentioBillingSignature(
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

  const webhookAge = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10))
  if (webhookAge > 300) return false

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

// ── Entrypoint ──────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const webhookSecret = Deno.env.get('STRIPE_BILLING_WEBHOOK_SECRET')
  if (!webhookSecret) {
    console.error(JSON.stringify({ level: 'error', function_name: 'sentio-billing-webhook', message: 'STRIPE_BILLING_WEBHOOK_SECRET is not configured' }))
    return errorResponse('Server configuration error', 500)
  }

  const rawBody = new Uint8Array(await req.arrayBuffer())
  const signature = req.headers.get('stripe-signature')

  const valid = await verifySentioBillingSignature(rawBody, signature, webhookSecret)
  if (!valid) return errorResponse('Invalid signature', 401)

  let event: StripeEvent
  try {
    event = JSON.parse(new TextDecoder().decode(rawBody))
  } catch {
    return errorResponse('Invalid JSON payload', 400)
  }

  let supabase: SupabaseClient
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'sentio-billing-webhook', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  return handleSentioBillingEvent(supabase, event)
})

// ── Handler ─────────────────────────────────────────────────

export async function handleSentioBillingEvent(
  supabase: SupabaseClient,
  event: StripeEvent,
): Promise<Response> {
  switch (event.type) {
    case 'customer.subscription.updated': {
      const sub = event.data.object as { id: string; status: string; current_period_end?: number; cancel_at_period_end?: boolean }
      const { error } = await supabase
        .from('sentio_subscriptions')
        .update({
          status: sub.status,
          current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
          cancel_at_period_end: sub.cancel_at_period_end ?? false,
        })
        .eq('sentio_stripe_subscription_id', sub.id)

      if (error) {
        console.error(JSON.stringify({ level: 'error', function_name: 'sentio-billing-webhook', op: 'subscription.updated', message: error.message }))
        return errorResponse('Failed to update subscription', 500)
      }
      break
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as { id: string }
      const { data: existing } = await supabase
        .from('sentio_subscriptions')
        .select('organization_id')
        .eq('sentio_stripe_subscription_id', sub.id)
        .maybeSingle()

      const { error } = await supabase
        .from('sentio_subscriptions')
        .update({
          status: 'canceled',
          plan_tier: 'free',
          sentio_stripe_subscription_id: null,
          cancel_at_period_end: false,
        })
        .eq('sentio_stripe_subscription_id', sub.id)

      if (error) {
        console.error(JSON.stringify({ level: 'error', function_name: 'sentio-billing-webhook', op: 'subscription.deleted', message: error.message }))
        return errorResponse('Failed to cancel subscription', 500)
      }

      if (existing?.organization_id) {
        await supabase.from('organizations').update({ plan_type: 'free' }).eq('id', existing.organization_id)
      }
      break
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as { customer?: string; subscription?: string }
      if (invoice.subscription) {
        // État de grâce : pas de gating punitif immédiat (cf. spec.md Assumptions) —
        // seul le statut est mis à jour, la synchronisation de plan_tier reste
        // entièrement pilotée par customer.subscription.updated/deleted.
        const { error } = await supabase
          .from('sentio_subscriptions')
          .update({ status: 'past_due' })
          .eq('sentio_stripe_subscription_id', invoice.subscription)

        if (error) {
          console.error(JSON.stringify({ level: 'error', function_name: 'sentio-billing-webhook', op: 'invoice.payment_failed', message: error.message }))
          return errorResponse('Failed to record payment failure', 500)
        }
      }
      break
    }

    default:
      break
  }

  return jsonResponse({ received: true, type: event.type })
}
