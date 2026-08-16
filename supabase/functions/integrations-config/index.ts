// ============================================================
// Edge Function : integrations-config
// Gestion des clés API d'intégration par organisation.
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// GET /integrations-config
//   Response 200 :
//     {
//       data: {
//         stripe_configured: boolean,
//         hubspot_configured: boolean,
//         stripe_account_id: string | null,
//         stripe_connection_method: 'api_key' | 'oauth' | null
//       }
//     }
//   (les clés ne sont jamais renvoyées ; stripe_account_id/connection_method
//   ajoutés pour la carte Settings → Integrations, cf. update-stripe-connection)
//
// POST /integrations-config
//   Body : { provider: 'stripe' | 'hubspot', api_key: string }
//   Response 200 : { success: true }
//   Response 400 : { error: string }
//
// Auth : JWT utilisateur vérifié dans le code (ES256 via verifyUserAuth)
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { withSentry } from '../_shared/sentry.ts'

const VALID_PROVIDERS = ['stripe', 'hubspot'] as const
type Provider = typeof VALID_PROVIDERS[number]

function validateApiKey(provider: Provider, apiKey: string): string | null {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    return 'api_key cannot be empty'
  }
  if (provider === 'stripe') {
    if (!apiKey.startsWith('sk_live_') && !apiKey.startsWith('sk_test_')) {
      return 'The Stripe key must start with sk_live_ or sk_test_'
    }
  }
  return null
}

Deno.serve(withSentry('integrations-config', async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'GET' && req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  let auth
  try {
    auth = await verifyUserAuth(req)
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.message, err.status)
    return errorResponse('Authentication failed', 401)
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'integrations-config', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const orgId = auth.organizationId

  if (req.method === 'GET') {
    const { data: org, error } = await supabase
      .from('organizations')
      .select('stripe_api_key, hubspot_api_key, stripe_account_id, stripe_connection_method')
      .eq('id', orgId)
      .maybeSingle()

    if (error) {
      console.error(JSON.stringify({ level: 'error', function_name: 'integrations-config', message: error.message }))
      return errorResponse('Failed to fetch integration status', 500)
    }

    return jsonResponse({
      data: {
        stripe_configured:  Boolean(org?.stripe_api_key),
        hubspot_configured: Boolean(org?.hubspot_api_key),
        stripe_account_id: org?.stripe_account_id ?? null,
        stripe_connection_method: org?.stripe_connection_method ?? null,
      },
    })
  }

  // POST
  let body: { provider?: unknown; api_key?: unknown }
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  const { provider, api_key } = body

  if (!provider || !VALID_PROVIDERS.includes(provider as Provider)) {
    return errorResponse(`provider must be one of: ${VALID_PROVIDERS.join(', ')}`, 400)
  }

  const validationError = validateApiKey(provider as Provider, api_key as string)
  if (validationError) {
    return errorResponse(validationError, 400)
  }

  const column = provider === 'stripe' ? 'stripe_api_key' : 'hubspot_api_key'

  const { error } = await supabase
    .from('organizations')
    .update({ [column]: (api_key as string).trim() })
    .eq('id', orgId)

  if (error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'integrations-config', message: error.message }))
    return errorResponse('Failed to save integration key', 500)
  }

  // Déclencher le pipeline onboarding automatiquement après connexion Stripe
  if (provider === 'stripe') {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    if (supabaseUrl && serviceKey) {
      fetch(`${supabaseUrl}/functions/v1/sync-stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
        body: JSON.stringify({ organization_id: orgId, sync_type: 'full_sync', triggered_by: 'onboarding' }),
      }).catch((err) => {
        console.error(JSON.stringify({
          level: 'warn',
          function_name: 'integrations-config',
          message: `onboarding sync trigger failed: ${err instanceof Error ? err.message : String(err)}`,
        }))
      })
    }
  }

  return jsonResponse({ success: true })
}))
