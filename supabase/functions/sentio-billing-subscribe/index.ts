// ============================================================
// Edge Function : sentio-billing-subscribe
// POST /sentio-billing/subscribe
// Facturation DE SENTIO auprès de ses organisations clientes.
//
// ⚠️ SÉPARATION STRICTE (cf. specs/003-pricing-billing-implementation/
// research.md, risque critique) : ce fichier utilise EXCLUSIVEMENT les
// secrets du compte Stripe Billing de Sentio (variables d'environnement
// dédiées, jamais de valeur en dur, jamais de repli vers les secrets de
// l'intégration Stripe qui lit les données de facturation des CLIENTS de
// chaque organisation). Aucun code, handler ou secret n'est partagé avec
// cette autre intégration — seul le protocole HTTP générique Stripe REST
// API est commun, comme documenté dans docs/stripe-billing-setup.md.
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'
import { VALID_PLAN_TIERS, isDowngradeIncoherent, type PlanTier, type TierLimits } from '../_shared/pricing.ts'

const STRIPE_API_BASE = 'https://api.stripe.com/v1'
const STRIPE_TIMEOUT_MS = 8000

interface SubscribeBody {
  target_plan_tier?: string
}

type StripeFetcher = (url: string, init: RequestInit) => Promise<Response>

// ── Entrypoint ──────────────────────────────────────────────

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

  let supabase: SupabaseClient
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'sentio-billing-subscribe', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  let body: SubscribeBody
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  return handleSubscribe(supabase, auth.organizationId, body)
})

// ── Handler ─────────────────────────────────────────────────

export async function handleSubscribe(
  supabase: SupabaseClient,
  orgId: string,
  body: SubscribeBody,
  stripeFetcher: StripeFetcher = (url, init) => fetchWithTimeout(url, init, STRIPE_TIMEOUT_MS),
): Promise<Response> {
  const targetPlanTier = body.target_plan_tier as PlanTier | undefined

  if (!targetPlanTier || !(VALID_PLAN_TIERS as readonly string[]).includes(targetPlanTier)) {
    return errorResponse(`target_plan_tier must be one of: ${VALID_PLAN_TIERS.join(', ')}`, 400)
  }

  // FR-012 : aucun chemin self-serve pour Scale/Enterprise.
  if (targetPlanTier === 'scale' || targetPlanTier === 'enterprise') {
    return errorResponse(
      `Self-serve subscription is not available for the ${targetPlanTier} plan — please book a call with our team.`,
      403,
    )
  }

  // Lecture stricte du secret Stripe Billing — jamais de repli silencieux.
  const stripeBillingSecretKey = Deno.env.get('STRIPE_BILLING_SECRET_KEY')
  if (!stripeBillingSecretKey) {
    console.error(JSON.stringify({ level: 'error', function_name: 'sentio-billing-subscribe', message: 'STRIPE_BILLING_SECRET_KEY is not configured' }))
    return errorResponse('Stripe Billing is not configured for this environment', 500)
  }

  const { count: activeAccountCount } = await supabase
    .from('accounts')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .gt('mrr_cents', 0)

  const { data: targetLimits, error: limitsError } = await supabase
    .from('pricing_tier_limits')
    .select('plan_tier, max_active_accounts, requires_appointment, alert_threshold_pct')
    .eq('plan_tier', targetPlanTier)
    .maybeSingle()

  if (limitsError || !targetLimits) {
    return errorResponse('Pricing tier limits not configured', 500)
  }

  // FR-013 : downgrade incohérent avec le nombre de comptes actifs du palier cible.
  if (isDowngradeIncoherent(targetLimits as TierLimits, activeAccountCount ?? 0)) {
    return errorResponse(
      `Cannot switch to ${targetPlanTier}: this organization has ${activeAccountCount} active accounts, above the ${targetPlanTier} limit of ${(targetLimits as TierLimits).max_active_accounts}.`,
      409,
    )
  }

  const { data: existingSub } = await supabase
    .from('sentio_subscriptions')
    .select('id, sentio_stripe_customer_id, sentio_stripe_subscription_id, plan_tier, status')
    .eq('organization_id', orgId)
    .maybeSingle()

  if (targetPlanTier === 'free') {
    return await handleDowngradeToFree(supabase, orgId, existingSub, stripeBillingSecretKey, stripeFetcher)
  }

  return await handleGrowthSubscription(supabase, orgId, existingSub, stripeBillingSecretKey, stripeFetcher)
}

// ── Downgrade vers Free : annule l'abonnement Stripe existant s'il y en a un ──

async function handleDowngradeToFree(
  supabase: SupabaseClient,
  orgId: string,
  existingSub: { sentio_stripe_subscription_id: string | null; sentio_stripe_customer_id: string } | null,
  stripeBillingSecretKey: string,
  stripeFetcher: StripeFetcher,
): Promise<Response> {
  if (existingSub?.sentio_stripe_subscription_id) {
    const resp = await stripeFetcher(
      `${STRIPE_API_BASE}/subscriptions/${existingSub.sentio_stripe_subscription_id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${stripeBillingSecretKey}` } },
    )
    if (!resp.ok) {
      const errText = await resp.text()
      console.error(JSON.stringify({ level: 'error', function_name: 'sentio-billing-subscribe', op: 'cancel', message: errText }))
      return errorResponse('Failed to cancel the Stripe Billing subscription', 500)
    }
  }

  const { data, error } = await supabase
    .from('sentio_subscriptions')
    .upsert({
      organization_id: orgId,
      sentio_stripe_customer_id: existingSub?.sentio_stripe_customer_id,
      sentio_stripe_subscription_id: null,
      plan_tier: 'free',
      status: 'active',
      cancel_at_period_end: false,
    }, { onConflict: 'organization_id' })
    .select('id, plan_tier, status')
    .single()

  if (error || !data) {
    console.error(JSON.stringify({ level: 'error', function_name: 'sentio-billing-subscribe', op: 'upsert_free', message: error?.message }))
    return errorResponse('Failed to update subscription record', 500)
  }

  await supabase.from('organizations').update({ plan_type: 'free' }).eq('id', orgId)

  return jsonResponse({ organization_id: orgId, plan_tier: data.plan_tier, status: data.status })
}

// ── Souscription/changement vers Growth ───────────────────────

async function handleGrowthSubscription(
  supabase: SupabaseClient,
  orgId: string,
  existingSub: { sentio_stripe_customer_id: string; sentio_stripe_subscription_id: string | null } | null,
  stripeBillingSecretKey: string,
  stripeFetcher: StripeFetcher,
): Promise<Response> {
  const priceId = Deno.env.get('STRIPE_BILLING_PRICE_ID_GROWTH')
  if (!priceId) {
    console.error(JSON.stringify({ level: 'error', function_name: 'sentio-billing-subscribe', message: 'STRIPE_BILLING_PRICE_ID_GROWTH is not configured' }))
    return errorResponse('Stripe Billing price for the growth plan is not configured', 500)
  }

  const authHeaders = { Authorization: `Bearer ${stripeBillingSecretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }

  let customerId = existingSub?.sentio_stripe_customer_id ?? null
  if (!customerId) {
    const resp = await stripeFetcher(`${STRIPE_API_BASE}/customers`, {
      method: 'POST',
      headers: authHeaders,
      body: new URLSearchParams({ 'metadata[organization_id]': orgId }).toString(),
    })
    if (!resp.ok) {
      console.error(JSON.stringify({ level: 'error', function_name: 'sentio-billing-subscribe', op: 'create_customer', message: await resp.text() }))
      return errorResponse('Failed to create the Stripe Billing customer', 500)
    }
    const customer = await resp.json() as { id: string }
    customerId = customer.id
  }

  let subscription: { id: string; status: string; current_period_end: number } | null = null

  if (existingSub?.sentio_stripe_subscription_id) {
    // Changement de palier sur un abonnement existant.
    const resp = await stripeFetcher(`${STRIPE_API_BASE}/subscriptions/${existingSub.sentio_stripe_subscription_id}`, {
      method: 'POST',
      headers: authHeaders,
      body: new URLSearchParams({ 'items[0][price]': priceId }).toString(),
    })
    if (!resp.ok) {
      console.error(JSON.stringify({ level: 'error', function_name: 'sentio-billing-subscribe', op: 'update_subscription', message: await resp.text() }))
      return errorResponse('Failed to update the Stripe Billing subscription', 500)
    }
    subscription = await resp.json()
  } else {
    const resp = await stripeFetcher(`${STRIPE_API_BASE}/subscriptions`, {
      method: 'POST',
      headers: authHeaders,
      body: new URLSearchParams({
        customer: customerId,
        'items[0][price]': priceId,
        payment_behavior: 'default_incomplete',
      }).toString(),
    })
    if (!resp.ok) {
      console.error(JSON.stringify({ level: 'error', function_name: 'sentio-billing-subscribe', op: 'create_subscription', message: await resp.text() }))
      return errorResponse('Failed to create the Stripe Billing subscription', 500)
    }
    subscription = await resp.json()
  }

  if (!subscription) return errorResponse('Unexpected empty Stripe Billing response', 500)

  const { data, error } = await supabase
    .from('sentio_subscriptions')
    .upsert({
      organization_id: orgId,
      sentio_stripe_customer_id: customerId,
      sentio_stripe_subscription_id: subscription.id,
      plan_tier: 'growth',
      status: subscription.status,
      current_period_end: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : null,
    }, { onConflict: 'organization_id' })
    .select('id, plan_tier, status, current_period_end')
    .single()

  if (error || !data) {
    console.error(JSON.stringify({ level: 'error', function_name: 'sentio-billing-subscribe', op: 'upsert_growth', message: error?.message }))
    return errorResponse('Failed to update subscription record', 500)
  }

  await supabase.from('organizations').update({ plan_type: 'growth' }).eq('id', orgId)

  return jsonResponse({
    organization_id: orgId,
    plan_tier: data.plan_tier,
    status: data.status,
    current_period_end: data.current_period_end,
  })
}
