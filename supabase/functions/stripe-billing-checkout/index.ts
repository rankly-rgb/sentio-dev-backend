// ============================================================
// Edge Function : stripe-billing-checkout
// Chantier C — crée une Stripe Checkout Session pour un upgrade
// self-serve (Growth/Scale) vers l'abonnement Sentio (compte Stripe de
// Sentio elle-même — STRIPE_SECRET_KEY, PAS le compte Stripe du client
// connecté en OAuth pour la sync de données).
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
// POST /stripe-billing-checkout
//   Auth : Bearer token utilisateur (JWT ES256)
//   Body : { tier: 'growth' | 'scale' }
//   Response 200 : { data: { checkout_url: string } }
//   Response 400 : tier invalide ou non self-serve (free/enterprise)
//   Response 503 : Stripe Price ID non configuré pour ce tier
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'
import { getTier, resolveStripePriceId, isSubscriptionTierKey } from '../_shared/subscription-tiers.ts'

interface CheckoutRequestBody {
  tier?: string
}

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  let auth
  try {
    auth = await verifyUserAuth(req)
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.message, err.status)
    return errorResponse('Authentication failed', 401)
  }

  let body: CheckoutRequestBody
  try {
    body = await req.json() as CheckoutRequestBody
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!isSubscriptionTierKey(body.tier)) {
    return errorResponse('tier must be one of: free, growth, scale, enterprise', 400)
  }

  const tier = getTier(body.tier)
  if (tier.cta !== 'self_serve' || !tier.stripe_price_id_env) {
    return errorResponse(`Tier '${tier.key}' is not self-serve — use the contact-sales flow instead`, 400)
  }

  const priceId = resolveStripePriceId(tier)
  if (!priceId) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'stripe-billing-checkout',
      message: `Missing ${tier.stripe_price_id_env} env var — cannot create checkout for tier ${tier.key}`,
    }))
    return errorResponse('Billing is not configured for this tier yet', 503)
  }

  const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY')
  if (!stripeSecretKey) {
    console.error(JSON.stringify({ level: 'error', function_name: 'stripe-billing-checkout', message: 'STRIPE_SECRET_KEY not configured' }))
    return errorResponse('Server configuration error', 500)
  }

  const appUrl = Deno.env.get('NEXT_PUBLIC_APP_URL') ?? 'https://app.sentioapp.io'

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'stripe-billing-checkout', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', auth.organizationId)
    .maybeSingle()

  const params = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    client_reference_id: auth.organizationId,
    'metadata[organization_id]': auth.organizationId,
    'metadata[tier]': tier.key,
    'subscription_data[metadata][organization_id]': auth.organizationId,
    'subscription_data[metadata][tier]': tier.key,
    success_url: `${appUrl}/settings?tab=billing&checkout=success`,
    cancel_url: `${appUrl}/settings?tab=billing&checkout=cancelled`,
  })

  let res: Response
  try {
    res = await fetchWithTimeout(
      'https://api.stripe.com/v1/checkout/sessions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      },
      8000,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'stripe-billing-checkout', organization_id: auth.organizationId, message: msg }))
    return errorResponse('Failed to reach Stripe', 502)
  }

  if (!res.ok) {
    const errBody = await res.text()
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'stripe-billing-checkout',
      organization_id: auth.organizationId,
      message: `Stripe checkout session creation failed: ${res.status} ${errBody}`,
    }))
    return errorResponse('Failed to create checkout session', 502)
  }

  const session = await res.json() as { url?: string }
  if (!session.url) {
    return errorResponse('Stripe did not return a checkout URL', 502)
  }

  console.log(JSON.stringify({
    level: 'info',
    function_name: 'stripe-billing-checkout',
    organization_id: auth.organizationId,
    organization_name: org?.name,
    tier: tier.key,
  }))

  return jsonResponse({ data: { checkout_url: session.url } })
})
