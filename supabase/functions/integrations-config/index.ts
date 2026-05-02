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
//         hubspot_configured: boolean
//       }
//     }
//   (les clés ne sont jamais renvoyées)
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

const VALID_PROVIDERS = ['stripe', 'hubspot'] as const
type Provider = typeof VALID_PROVIDERS[number]

function validateApiKey(provider: Provider, apiKey: string): string | null {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    return 'api_key ne peut pas être vide'
  }
  if (provider === 'stripe') {
    if (!apiKey.startsWith('sk_live_') && !apiKey.startsWith('sk_test_')) {
      return 'La clé Stripe doit commencer par sk_live_ ou sk_test_'
    }
  }
  return null
}

Deno.serve(async (req: Request): Promise<Response> => {
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
      .select('stripe_api_key, hubspot_api_key')
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
    return errorResponse(`provider doit être l'un de : ${VALID_PROVIDERS.join(', ')}`, 400)
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

  return jsonResponse({ success: true })
})
