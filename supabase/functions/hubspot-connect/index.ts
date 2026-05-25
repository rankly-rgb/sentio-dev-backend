// ============================================================
// Edge Function : hubspot-connect
// POST /hubspot-connect
//
// Valide un token HubSpot Private App, le stocke dans Vault,
// met à jour l'org et déclenche le sync HubSpot en fire-and-forget.
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
// POST /hubspot-connect
//   Auth : Bearer token (JWT ES256)
//   Body : { hubspot_api_key: string }
//   Response 200 (toujours) :
//     Succès : { success: true }
//     Échec  : { success: false, error: string }
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'

export function validateHubSpotKeyFormat(key: string): boolean {
  return typeof key === 'string' && key.startsWith('pat-')
}

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') return jsonResponse({ success: false, error: 'Method not allowed' })

  let auth
  try {
    auth = await verifyUserAuth(req)
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse({ success: false, error: err.message })
    return jsonResponse({ success: false, error: 'Authentication failed' })
  }

  let body: { hubspot_api_key?: unknown }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON body' })
  }

  const { hubspot_api_key } = body
  if (!hubspot_api_key || typeof hubspot_api_key !== 'string') {
    return jsonResponse({ success: false, error: 'hubspot_api_key est requis' })
  }

  if (!validateHubSpotKeyFormat(hubspot_api_key)) {
    return jsonResponse({ success: false, error: 'Format invalide. Le token doit commencer par pat-' })
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'hubspot-connect', message: msg }))
    return jsonResponse({ success: false, error: 'Server configuration error' })
  }

  const orgId = auth.organizationId

  // Tester la clé contre l'API HubSpot
  let hubspotRes: Response
  try {
    hubspotRes = await fetchWithTimeout(
      'https://api.hubapi.com/crm/v3/objects/companies?limit=1',
      { headers: { Authorization: `Bearer ${hubspot_api_key}` } },
      8000,
    )
  } catch {
    return jsonResponse({ success: false, error: 'Impossible de joindre HubSpot. Réessayez dans quelques instants.' })
  }

  if (!hubspotRes.ok) {
    return jsonResponse({ success: false, error: 'Clé HubSpot invalide ou permissions insuffisantes' })
  }

  // Stocker la clé dans Vault
  const vaultName = `hubspot_key_org_${orgId}`
  const { error: vaultErr } = await supabase.rpc('vault_create_secret', {
    secret: hubspot_api_key,
    name: vaultName,
  })

  if (vaultErr) {
    console.error(JSON.stringify({
      level: 'warn',
      function_name: 'hubspot-connect',
      message: 'Vault storage failed, proceeding without',
      error: vaultErr.message,
    }))
  }

  // Mettre à jour l'organisation
  const { error: updateErr } = await supabase
    .from('organizations')
    .update({ hubspot_connected: true })
    .eq('id', orgId)

  if (updateErr) {
    console.error(JSON.stringify({ level: 'error', function_name: 'hubspot-connect', message: updateErr.message }))
    return jsonResponse({ success: false, error: 'Erreur mise à jour organisation' })
  }

  // Marquer l'onboarding comme terminé si on n'est pas encore au-delà de l'étape hubspot (idempotent)
  await supabase
    .from('organizations')
    .update({ onboarding_step: 'completed', onboarding_completed: true })
    .eq('id', orgId)
    .in('onboarding_step', ['hubspot', 'invested', 'revelation', 'stripe', 'promise'])

  // Fire-and-forget : déclencher le sync HubSpot
  const syncUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/sync-hubspot`
  const syncPromise = fetch(syncUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ organization_id: orgId, triggered_by: 'onboarding' }),
  }).catch((err) => {
    console.error(JSON.stringify({ level: 'warn', function_name: 'hubspot-connect', message: 'sync-hubspot fire-and-forget failed', error: String(err) }))
  })

  try {
    // deno-lint-ignore no-explicit-any
    ;(globalThis as any).EdgeRuntime?.waitUntil(syncPromise)
  } catch {
    // EdgeRuntime non disponible en local — pas bloquant
  }

  console.log(JSON.stringify({
    level: 'info',
    function_name: 'hubspot-connect',
    organization_id: orgId,
  }))

  return jsonResponse({ success: true })
})
