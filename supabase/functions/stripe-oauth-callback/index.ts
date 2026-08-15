// ============================================================
// Edge Function : stripe-oauth-callback
// POST /stripe-oauth-callback
//
// Valide le state CSRF, échange le code Stripe contre un token,
// stocke le stripe_user_id et déclenche le sync en fire-and-forget.
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
// POST /stripe-oauth-callback
//   Auth : Bearer token (JWT ES256)
//   Body : { code: string, state: string }
//   Response 200 : { success: true }
//   Response 400 : { error: string }
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, jsonResponse, errorResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'
import {
  findConflictingOrganization,
  isStripeAccountConflict,
  STRIPE_ACCOUNT_CONFLICT_MESSAGE,
  STRIPE_ACCOUNT_CONFLICT_STATUS,
} from '../_shared/stripe-account-claim.ts'

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

  let body: { code?: unknown; state?: unknown }
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  const { code, state } = body
  if (!code || typeof code !== 'string') return errorResponse('code is required', 400)
  if (!state || typeof state !== 'string') return errorResponse('state is required', 400)

  const stripeSecret = Deno.env.get('STRIPE_SECRET_KEY')
  if (!stripeSecret) {
    console.error(JSON.stringify({ level: 'error', function_name: 'stripe-oauth-callback', message: 'STRIPE_SECRET_KEY not set' }))
    return errorResponse('OAuth not configured', 500)
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'stripe-oauth-callback', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const orgId = auth.organizationId

  // Valider et consommer le state
  const { data: oauthState, error: stateErr } = await supabase
    .from('oauth_states')
    .select('id, organization_id')
    .eq('state', state)
    .eq('provider', 'stripe')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  if (stateErr || !oauthState) {
    return errorResponse('Invalid or expired state', 400)
  }

  if (oauthState.organization_id !== orgId) {
    return errorResponse('State does not match the organization', 403)
  }

  // Supprimer le state utilisé (one-time use)
  await supabase.from('oauth_states').delete().eq('id', oauthState.id)

  // Échanger le code contre un token Stripe
  let tokenRes: Response
  try {
    const params = new URLSearchParams({
      client_secret: stripeSecret,
      code,
      grant_type: 'authorization_code',
    })
    tokenRes = await fetchWithTimeout(
      'https://connect.stripe.com/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      },
      8000,
    )
  } catch {
    return errorResponse('Could not reach Stripe. Please try again shortly.', 502)
  }

  if (!tokenRes.ok) {
    const errBody = await tokenRes.json().catch(() => ({}))
    console.error(JSON.stringify({ level: 'error', function_name: 'stripe-oauth-callback', message: 'Token exchange failed', stripe_error: errBody }))
    return errorResponse('Stripe OAuth token exchange failed', 400)
  }

  const tokenData = await tokenRes.json()
  const stripeUserId: string = tokenData.stripe_user_id

  if (!stripeUserId) {
    return errorResponse('stripe_user_id missing from Stripe response', 500)
  }

  // Stocker stripe_user_id dans Vault
  // Même garde que `update-stripe-connection` : `organizations.
  // stripe_account_id` est UNIQUE globalement, et une collision remontait
  // ici aussi en 500 générique. Vérifié avant l'écriture Vault pour qu'un
  // refus ne laisse aucun état partiel derrière lui.
  const { conflictingOrgId, lookupFailed } = await findConflictingOrganization(supabase, stripeUserId, orgId)
  if (conflictingOrgId) {
    console.warn(JSON.stringify({
      level: 'warn',
      function_name: 'stripe-oauth-callback',
      organization_id: orgId,
      message: 'stripe_account_id already claimed by another organization',
      conflicting_organization_id: conflictingOrgId,
    }))
    return errorResponse(STRIPE_ACCOUNT_CONFLICT_MESSAGE, STRIPE_ACCOUNT_CONFLICT_STATUS)
  }
  if (lookupFailed) {
    // Lecture impossible ≠ pas de conflit : on laisse la contrainte DB trancher.
    console.warn(JSON.stringify({
      level: 'warn',
      function_name: 'stripe-oauth-callback',
      organization_id: orgId,
      message: 'stripe_account_id conflict lookup failed, deferring to DB constraint',
    }))
  }

  const { error: vaultErr } = await supabase.rpc('vault_create_secret', {
    secret: stripeUserId,
    name: `stripe_oauth_org_${orgId}`,
  })

  if (vaultErr) {
    console.error(JSON.stringify({
      level: 'warn',
      function_name: 'stripe-oauth-callback',
      message: 'Vault storage failed',
      error: vaultErr.message,
    }))
  }

  // Mettre à jour l'organisation
  const { error: updateErr } = await supabase
    .from('organizations')
    .update({
      stripe_connected: true,
      stripe_account_id: stripeUserId,
      stripe_connection_method: 'oauth',
    })
    .eq('id', orgId)

  if (updateErr) {
    console.error(JSON.stringify({ level: 'error', function_name: 'stripe-oauth-callback', message: updateErr.message }))
    if (isStripeAccountConflict(updateErr)) {
      return errorResponse(STRIPE_ACCOUNT_CONFLICT_MESSAGE, STRIPE_ACCOUNT_CONFLICT_STATUS)
    }
    return errorResponse('Failed to update organization', 500)
  }

  // Avancer l'étape seulement si on n'est pas déjà plus loin (idempotent)
  await supabase
    .from('organizations')
    .update({ onboarding_step: 'revelation', first_revelation_at: new Date().toISOString() })
    .eq('id', orgId)
    .in('onboarding_step', ['promise', 'stripe'])

  // Fire-and-forget : déclencher le sync initial
  const syncUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/sync-stripe`
  const syncPromise = fetch(syncUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ organization_id: orgId, triggered_by: 'onboarding' }),
  }).catch((err) => {
    console.error(JSON.stringify({ level: 'warn', function_name: 'stripe-oauth-callback', message: 'sync-stripe fire-and-forget failed', error: String(err) }))
  })

  try {
    // deno-lint-ignore no-explicit-any
    ;(globalThis as any).EdgeRuntime?.waitUntil(syncPromise)
  } catch {
    // EdgeRuntime non disponible en local — pas bloquant
  }

  console.log(JSON.stringify({
    level: 'info',
    function_name: 'stripe-oauth-callback',
    organization_id: orgId,
  }))

  return jsonResponse({ success: true })
})
