// ============================================================
// Edge Function : verify-stripe-token
// POST /verify-stripe-token
//
// Valide une clé API Stripe restreinte, la stocke dans Vault,
// met à jour l'org et déclenche le sync initial en fire-and-forget.
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
// POST /verify-stripe-token
//   Auth : Bearer token (JWT ES256)
//   Body : { stripe_api_key: string }
//   Response 200 (toujours) :
//     Succès : { success: true, mode: "live" | "test" }
//     Échec  : { success: false, error: string }
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'
import { withSentry } from '../_shared/sentry.ts'

const VALID_PREFIXES = ['rk_live_', 'rk_test_', 'sk_live_', 'sk_test_'] as const
const MIN_SUFFIX_LENGTH = 20

export function validateStripeKeyFormat(key: string): { valid: boolean; mode: 'live' | 'test' } {
  for (const prefix of VALID_PREFIXES) {
    if (key.startsWith(prefix) && key.length >= prefix.length + MIN_SUFFIX_LENGTH) {
      const mode = prefix.includes('live') ? 'live' : 'test'
      return { valid: true, mode }
    }
  }
  return { valid: false, mode: 'test' }
}

Deno.serve(withSentry('verify-stripe-token', async (req: Request): Promise<Response> => {
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

  let body: { stripe_api_key?: unknown }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON body' })
  }

  const { stripe_api_key } = body
  if (!stripe_api_key || typeof stripe_api_key !== 'string') {
    return jsonResponse({ success: false, error: 'stripe_api_key is required' })
  }

  const { valid, mode } = validateStripeKeyFormat(stripe_api_key)
  if (!valid) {
    return jsonResponse({ success: false, error: 'Invalid key format' })
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'verify-stripe-token', message: msg }))
    return jsonResponse({ success: false, error: 'Server configuration error' })
  }

  const orgId = auth.organizationId

  // Tester la clé contre l'API Stripe
  let stripeRes: Response
  try {
    stripeRes = await fetchWithTimeout(
      'https://api.stripe.com/v1/customers?limit=1',
      { headers: { Authorization: `Bearer ${stripe_api_key}` } },
      8000,
    )
  } catch {
    return jsonResponse({ success: false, error: 'Could not reach Stripe. Please try again shortly.' })
  }

  if (stripeRes.status === 401 || stripeRes.status === 403) {
    return jsonResponse({ success: false, error: 'Invalid Stripe key or insufficient permissions' })
  }

  if (!stripeRes.ok) {
    return jsonResponse({ success: false, error: 'Could not reach Stripe. Please try again shortly.' })
  }

  // Stocker la clé dans Vault (best-effort — voir commentaire ci-dessous,
  // cette écriture échoue systématiquement aujourd'hui et n'est pas ce que
  // sync-stripe lit).
  const vaultName = `stripe_key_org_${orgId}`
  const { error: vaultErr } = await supabase.rpc('vault_create_secret', {
    secret: stripe_api_key,
    name: vaultName,
  })

  if (vaultErr) {
    console.error(JSON.stringify({
      level: 'warn',
      function_name: 'verify-stripe-token',
      message: 'Vault storage failed, proceeding without',
      error: vaultErr.message,
    }))
  }

  // 2026-08-17 : `stripe_api_key` ajouté à cet UPDATE — c'est la colonne que
  // `sync-stripe` lit réellement (`orgsToSync[0].stripe_api_key`), jamais le
  // Vault ci-dessus. Root cause d'un signup neuf resté bloqué indéfiniment
  // sur « Building cohorts » : `vault_create_secret` n'existe pas en base
  // (confirmé en direct, `pg_proc` — seul `vault_store_secret` existe, nom
  // et signature différents ; le commentaire de la migration
  // `20260802000008` avait supposé son existence par erreur, sur la seule
  // preuve d'une collision de nom sur une AUTRE fonction Vault). L'échec
  // Vault était déjà non bloquant par design — mais rien ne prenait le
  // relais : cette colonne n'était encore écrite nulle part sur ce chemin.
  // `update-stripe-connection` (Settings, chemin de reconnexion) écrit déjà
  // cette même colonne avec succès — même pattern, repris ici tel quel.
  // Le nom de RPC Vault erroné existe aussi côté `update-stripe-connection`
  // (`upsertVaultSecret`, branche première connexion) : bug distinct,
  // signalé mais non corrigé ici — ce chemin traite déjà l'échec Vault
  // comme bloquant (500), donc pas de faux positif silencieux comme ici,
  // hors du périmètre de ce correctif.
  //
  // Mettre à jour l'organisation + avancer onboarding_step si encore à 'promise' ou 'stripe'
  const { error: updateErr } = await supabase
    .from('organizations')
    .update({
      stripe_api_key,
      stripe_connected: true,
      stripe_connection_method: 'api_key',
    })
    .eq('id', orgId)

  if (updateErr) {
    console.error(JSON.stringify({ level: 'error', function_name: 'verify-stripe-token', message: updateErr.message }))
    return jsonResponse({ success: false, error: 'Failed to update organization' })
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
    console.error(JSON.stringify({ level: 'warn', function_name: 'verify-stripe-token', message: 'sync-stripe fire-and-forget failed', error: String(err) }))
  })

  try {
    // deno-lint-ignore no-explicit-any
    ;(globalThis as any).EdgeRuntime?.waitUntil(syncPromise)
  } catch {
    // EdgeRuntime non disponible en local — pas bloquant
  }

  console.log(JSON.stringify({
    level: 'info',
    function_name: 'verify-stripe-token',
    organization_id: orgId,
    mode,
  }))

  return jsonResponse({ success: true, mode })
}))
