// ============================================================
// Edge Function : stripe-oauth-initiate
// GET /stripe-oauth-initiate
//
// Génère un state CSRF, l'insère dans oauth_states,
// retourne l'URL d'autorisation Stripe OAuth.
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
// GET /stripe-oauth-initiate
//   Auth : Bearer token (JWT ES256)
//   Response 200 : { url: string }
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, jsonResponse, errorResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'GET') return errorResponse('Method not allowed', 405)

  let auth
  try {
    auth = await verifyUserAuth(req)
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.message, err.status)
    return errorResponse('Authentication failed', 401)
  }

  const clientId = Deno.env.get('STRIPE_CLIENT_ID')
  const appUrl = Deno.env.get('NEXT_PUBLIC_APP_URL') ?? 'https://app.sentioapp.io'

  if (!clientId) {
    console.error(JSON.stringify({ level: 'error', function_name: 'stripe-oauth-initiate', message: 'STRIPE_CLIENT_ID not set' }))
    return errorResponse('OAuth not configured', 500)
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'stripe-oauth-initiate', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const orgId = auth.organizationId
  const state = crypto.randomUUID()

  const { error: insertErr } = await supabase
    .from('oauth_states')
    .insert({
      state,
      organization_id: orgId,
      provider: 'stripe',
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })

  if (insertErr) {
    console.error(JSON.stringify({ level: 'error', function_name: 'stripe-oauth-initiate', message: insertErr.message }))
    return errorResponse('Failed to initiate OAuth', 500)
  }

  const redirectUri = `${appUrl}/onboarding/stripe-callback`
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: 'read_only',
    state,
    redirect_uri: redirectUri,
  })

  const url = `https://connect.stripe.com/oauth/authorize?${params.toString()}`

  return jsonResponse({ url })
})
