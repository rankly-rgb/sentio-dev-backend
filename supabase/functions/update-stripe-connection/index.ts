// ============================================================
// Edge Function : update-stripe-connection
// Remplace ou déconnecte la clé Stripe (restreinte rk_ ou secrète complète
// sk_) d'une org depuis
// Settings → Integrations (le flux qui manquait : voir CHANGELOG_STABILITY.md
// "Stripe connection update/disconnect v1" pour le contexte complet).
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
// POST /update-stripe-connection
//   Body (update)     : { action: 'update', stripe_api_key: string }
//   Body (disconnect) : { action: 'disconnect' }
//   Response 200 (update)     : { success: true, mode: 'live'|'test', account_id: string|null }
//   Response 200 (disconnect) : { success: true }
//   Response 400/401/403/502 : { error: string }
//
// Auth : JWT utilisateur vérifié dans le code (ES256 via verifyUserAuth),
// toutes les écritures scopées par organizationId issu du JWT (jamais un
// org_id de body).
//
// Stockage : Vault (organization_integrations.vault_access_token_id, provider
// 'stripe') est la source canonique — remplacée en place via
// vault_replace_secret plutôt qu'accumulée à chaque appel. organizations.
// stripe_api_key est aussi mis à jour en écriture directe : c'est la colonne
// que sync-stripe lit réellement aujourd'hui (voir sync-stripe/index.ts), donc
// sans ce double-write "mettre à jour la clé" ne changerait rien à la
// prochaine sync. Faire converger sync-stripe vers une résolution Vault-only
// (à la manière de resolveHubSpotApiKey) est un changement plus large touchant
// le comportement de sync pour tous les modes de connexion existants — hors
// scope ici, laissé en l'état.
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'

// Restreintes (rk_) ET secrètes complètes (sk_) toutes deux acceptées —
// aligné avec verify-stripe-token/integrations-config, qui acceptent déjà
// les deux. Une clé sk_ n'est jamais "read-only" au sens strict (Stripe ne
// distingue pas les scopes sur ce type de clé), mais les 3 appels de lecture
// ci-dessous (validateStripeKeyLive) restent le seul contrôle réellement
// applicable côté API — accepter sk_ ne réduit pas cette vérification, ça
// élargit juste le format de clé accepté en amont.
const VALID_PREFIXES = ['rk_live_', 'rk_test_', 'sk_live_', 'sk_test_'] as const
const MIN_SUFFIX_LENGTH = 20

// Ressources que sync-stripe lit réellement (customers, subscriptions,
// invoices) — la clé restreinte doit pouvoir lire chacune, sinon la
// prochaine sync échouerait silencieusement sur cette ressource.
const REQUIRED_READ_PATHS = [
  { path: '/v1/customers?limit=1', label: 'Customers' },
  { path: '/v1/subscriptions?limit=1', label: 'Subscriptions' },
  { path: '/v1/invoices?limit=1', label: 'Invoices' },
] as const

export function validateStripeKeyFormat(key: string): { valid: boolean; mode: 'live' | 'test' } {
  for (const prefix of VALID_PREFIXES) {
    if (key.startsWith(prefix) && key.length >= prefix.length + MIN_SUFFIX_LENGTH) {
      return { valid: true, mode: prefix.includes('live') ? 'live' : 'test' }
    }
  }
  return { valid: false, mode: 'test' }
}

interface StripeValidationResult {
  ok: boolean
  error?: string
}

// Vérifie que la clé fonctionne ET qu'elle a accès en lecture aux 3
// ressources dont sync-stripe a besoin. Stripe n'expose pas d'endpoint
// d'introspection des permissions d'une clé (restreinte ou secrète complète)
// — cette vérification se limite donc à ce qui est réellement observable via
// l'API publique : ces 3 appels garantissent "peut lire ce dont Sentio a
// besoin", pas une preuve formelle d'absence d'accès en écriture (une clé sk_
// en a de toute façon, c'est inhérent à ce type de clé).
async function validateStripeKeyLive(apiKey: string): Promise<StripeValidationResult> {
  for (const { path, label } of REQUIRED_READ_PATHS) {
    let res: Response
    try {
      res = await fetchWithTimeout(
        `https://api.stripe.com${path}`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
        8000,
      )
    } catch {
      return { ok: false, error: 'Could not reach Stripe. Please try again shortly.' }
    }

    if (res.status === 401) {
      return { ok: false, error: 'Invalid Stripe key' }
    }
    if (res.status === 403) {
      return { ok: false, error: `This key can't read ${label} — check its permissions in Stripe → Developers → API keys` }
    }
    if (!res.ok) {
      return { ok: false, error: 'Could not reach Stripe. Please try again shortly.' }
    }
  }
  return { ok: true }
}

// Meilleur effort : /v1/account n'est pas forcément dans le scope d'une clé
// restreinte par défaut. Un échec ici ne bloque pas la mise à jour — l'account
// id affiché reste simplement inchangé si on ne peut pas le lire.
async function tryFetchAccountId(apiKey: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      'https://api.stripe.com/v1/account',
      { headers: { Authorization: `Bearer ${apiKey}` } },
      8000,
    )
    if (!res.ok) return null
    const account = await res.json()
    return typeof account?.id === 'string' ? account.id : null
  } catch {
    return null
  }
}

async function upsertVaultSecret(
  supabase: SupabaseClient,
  organizationId: string,
  apiKey: string,
): Promise<{ error: string | null }> {
  const { data: existing } = await supabase
    .from('organization_integrations')
    .select('id, vault_access_token_id')
    .eq('organization_id', organizationId)
    .eq('provider', 'stripe')
    .maybeSingle()

  if (existing?.vault_access_token_id) {
    const { error } = await supabase.rpc('vault_replace_secret', {
      p_secret_id: existing.vault_access_token_id,
      p_new_secret: apiKey,
    })
    if (error) return { error: error.message }

    await supabase
      .from('organization_integrations')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', existing.id)

    return { error: null }
  }

  // Nom unique par appel (pas juste par org) : évite une collision avec un
  // éventuel secret déjà créé sous le nom fixe stripe_key_org_${orgId} par
  // verify-stripe-token (onboarding), dont l'id n'est jamais persisté nulle
  // part — un bug préexistant distinct, hors scope ici, mais qui rendrait un
  // nom fixe partagé fragile.
  const vaultName = `stripe_key_org_${organizationId}_${crypto.randomUUID()}`
  const { data: created, error: createErr } = await supabase
    .rpc('vault_create_secret', { secret: apiKey, name: vaultName })

  if (createErr) return { error: createErr.message }

  // vault_create_secret n'est définie dans aucune migration versionnée (voir
  // le commentaire de la migration 20260802000008) — son type de retour exact
  // n'est donc pas garanti. vault.create_secret() (le builtin Supabase sous-
  // jacent) renvoie un uuid scalaire ; on gère aussi le cas où le wrapper le
  // renverrait dans une ligne { id }, au cas où.
  const secretId = typeof created === 'string'
    ? created
    : ((created as { id?: string } | null)?.id ?? null)
  if (!secretId) {
    return { error: 'Vault did not return a secret id' }
  }

  const { error: upsertErr } = await supabase
    .from('organization_integrations')
    .upsert(
      {
        organization_id: organizationId,
        provider: 'stripe',
        status: 'active',
        vault_access_token_id: secretId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,provider' },
    )

  if (upsertErr) return { error: upsertErr.message }
  return { error: null }
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

  let body: { action?: unknown; stripe_api_key?: unknown }
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  const { action } = body
  if (action !== 'update' && action !== 'disconnect') {
    return errorResponse("action must be 'update' or 'disconnect'", 400)
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'update-stripe-connection', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const orgId = auth.organizationId

  if (action === 'disconnect') {
    const { data: existing } = await supabase
      .from('organization_integrations')
      .select('id, vault_access_token_id')
      .eq('organization_id', orgId)
      .eq('provider', 'stripe')
      .maybeSingle()

    if (existing?.vault_access_token_id) {
      const { error: deleteErr } = await supabase.rpc('vault_remove_secret', { p_secret_id: existing.vault_access_token_id })
      if (deleteErr) {
        console.error(JSON.stringify({ level: 'warn', function_name: 'update-stripe-connection', message: `vault_remove_secret failed: ${deleteErr.message}` }))
      }
      await supabase
        .from('organization_integrations')
        .update({ status: 'inactive', vault_access_token_id: null, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    }

    const { error: orgErr } = await supabase
      .from('organizations')
      .update({ stripe_api_key: null, stripe_connected: false, stripe_connection_method: null })
      .eq('id', orgId)

    if (orgErr) {
      console.error(JSON.stringify({ level: 'error', function_name: 'update-stripe-connection', message: orgErr.message }))
      return errorResponse('Failed to disconnect Stripe', 500)
    }

    console.log(JSON.stringify({ level: 'info', function_name: 'update-stripe-connection', organization_id: orgId, action: 'disconnect' }))
    return jsonResponse({ success: true })
  }

  // action === 'update'
  const { stripe_api_key: rawKey } = body
  if (!rawKey || typeof rawKey !== 'string') {
    return errorResponse('stripe_api_key is required', 400)
  }
  const apiKey = rawKey.trim()

  const { valid, mode } = validateStripeKeyFormat(apiKey)
  if (!valid) {
    return errorResponse('The key must be a Stripe key starting with rk_live_, rk_test_, sk_live_, or sk_test_', 400)
  }

  const validation = await validateStripeKeyLive(apiKey)
  if (!validation.ok) {
    return errorResponse(validation.error ?? 'Stripe key validation failed', 400)
  }

  const { error: vaultError } = await upsertVaultSecret(supabase, orgId, apiKey)
  if (vaultError) {
    console.error(JSON.stringify({ level: 'error', function_name: 'update-stripe-connection', message: `Vault storage failed: ${vaultError}` }))
    return errorResponse('Failed to store the key securely. Please try again.', 500)
  }

  const accountId = await tryFetchAccountId(apiKey)

  const orgUpdate: Record<string, unknown> = {
    stripe_api_key: apiKey,
    stripe_connected: true,
    stripe_connection_method: 'api_key',
  }
  if (accountId) orgUpdate.stripe_account_id = accountId

  const { error: orgErr } = await supabase
    .from('organizations')
    .update(orgUpdate)
    .eq('id', orgId)

  if (orgErr) {
    console.error(JSON.stringify({ level: 'error', function_name: 'update-stripe-connection', message: orgErr.message }))
    return errorResponse('Failed to update the organization record', 500)
  }

  // Fire-and-forget : la nouvelle clé ne sert à rien tant qu'une sync n'a pas
  // tourné avec elle.
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (supabaseUrl && serviceKey) {
    const syncPromise = fetch(`${supabaseUrl}/functions/v1/sync-stripe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({ organization_id: orgId, sync_type: 'full_sync', triggered_by: 'stripe_key_update' }),
    }).catch((err) => {
      console.error(JSON.stringify({ level: 'warn', function_name: 'update-stripe-connection', message: `sync-stripe fire-and-forget failed: ${String(err)}` }))
    })

    try {
      // deno-lint-ignore no-explicit-any
      ;(globalThis as any).EdgeRuntime?.waitUntil(syncPromise)
    } catch {
      // EdgeRuntime non disponible en local — pas bloquant
    }
  }

  console.log(JSON.stringify({ level: 'info', function_name: 'update-stripe-connection', organization_id: orgId, action: 'update', mode }))
  return jsonResponse({ success: true, mode, account_id: accountId })
})
