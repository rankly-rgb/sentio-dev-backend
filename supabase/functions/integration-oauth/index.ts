// ============================================================
// Edge Function : integration-oauth
// Flux OAuth pour connecter Stripe Connect et HubSpot par org.
//
// Routes :
//   GET  /integration-oauth/stripe/authorize   — URL OAuth Stripe
//   GET  /integration-oauth/stripe/callback    — Echange code Stripe
//   GET  /integration-oauth/hubspot/authorize  — URL OAuth HubSpot
//   GET  /integration-oauth/hubspot/callback   — Echange code HubSpot
//   GET  /integration-oauth/status             — Statut des integrations
//   POST /integration-oauth/revoke             — Revoquer une integration
//
// Auth : ES256 JWT (verify_jwt = false, auth dans le code)
// Zero-PII : jamais d'email, nom, telephone dans les tokens/responses
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { storeVaultSecret, deleteVaultSecret } from '../_shared/vault.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'
import { alertSlack } from '../_shared/slack-alert.ts'
import {
  isValidProvider,
  isStateExpired,
  isValidRedirectUrl,
  buildStripeAuthorizeUrl,
  buildHubSpotAuthorizeUrl,
  parseCallbackParams,
  buildIntegrationSummary,
  STRIPE_SCOPES,
  HUBSPOT_SCOPES,
  type OAuthProvider,
} from '../_shared/oauth-helpers.ts'

// ── Route parsing ─────────────────────────────────────────────

function getRouteParts(req: Request): { segments: string[]; raw: string } {
  const url = new URL(req.url)
  const match = url.pathname.match(/\/integration-oauth\/(.+)/)
  const raw = match ? match[1] : ''
  return { segments: raw.split('/').filter(Boolean), raw }
}

// ── Main handler ──────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  const { segments, raw } = getRouteParts(req)

  // ── Callback routes (pas d'auth JWT — le state CSRF protege) ──
  // Les callbacks sont appeles par le navigateur apres redirect OAuth,
  // donc le JWT n'est pas disponible dans l'URL query string.
  if (segments.length === 2 && segments[1] === 'callback' && req.method === 'GET') {
    const provider = segments[0]
    if (!isValidProvider(provider)) {
      return errorResponse('Provider invalide', 400)
    }
    return handleCallback(req, provider)
  }

  // ── Toutes les autres routes requierent un JWT ──
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
  } catch {
    return errorResponse('Server configuration error', 500)
  }

  const orgId = auth.organizationId

  // ── GET /{provider}/authorize ───────────────────────────────
  if (segments.length === 2 && segments[1] === 'authorize' && req.method === 'GET') {
    const provider = segments[0]
    if (!isValidProvider(provider)) {
      return errorResponse('Provider invalide', 400)
    }

    // Verifier si deja connecte
    const { data: existing } = await supabase
      .from('organization_integrations')
      .select('status')
      .eq('organization_id', orgId)
      .eq('provider', provider)
      .eq('status', 'active')
      .maybeSingle()

    if (existing) {
      return errorResponse(`${provider} est deja connecte. Revoquez d'abord l'integration existante.`, 409)
    }

    // Extraire redirect_after optionnel
    const url = new URL(req.url)
    const redirectAfter = url.searchParams.get('redirect_after')
    if (!isValidRedirectUrl(redirectAfter)) {
      return errorResponse('redirect_after doit etre une URL HTTPS', 400)
    }

    // Generer state anti-CSRF
    const state = crypto.randomUUID() + '-' + crypto.randomUUID()

    // Nettoyer les states expires pour cette org/provider
    await supabase
      .from('oauth_states')
      .delete()
      .eq('organization_id', orgId)
      .eq('provider', provider)
      .lt('expires_at', new Date().toISOString())

    // Stocker le state
    const { error: stateError } = await supabase
      .from('oauth_states')
      .insert({
        organization_id: orgId,
        provider,
        state,
        redirect_after: redirectAfter,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      })

    if (stateError) {
      return errorResponse('Erreur lors de la creation du state OAuth', 500)
    }

    // Construire l'URL OAuth
    let authorizationUrl: string
    if (provider === 'stripe') {
      const clientId = Deno.env.get('STRIPE_CONNECT_CLIENT_ID')
      const redirectUri = Deno.env.get('STRIPE_OAUTH_REDIRECT_URI')
      if (!clientId || !redirectUri) {
        return errorResponse('Configuration Stripe Connect manquante', 500)
      }
      authorizationUrl = buildStripeAuthorizeUrl(clientId, redirectUri, state)
    } else {
      const clientId = Deno.env.get('HUBSPOT_CLIENT_ID')
      const redirectUri = Deno.env.get('HUBSPOT_OAUTH_REDIRECT_URI')
      if (!clientId || !redirectUri) {
        return errorResponse('Configuration HubSpot OAuth manquante', 500)
      }
      authorizationUrl = buildHubSpotAuthorizeUrl(clientId, redirectUri, state)
    }

    return jsonResponse({ authorization_url: authorizationUrl })
  }

  // ── GET /status ─────────────────────────────────────────────
  if (raw === 'status' && req.method === 'GET') {
    const { data: integrations } = await supabase
      .from('organization_integrations')
      .select('provider, provider_account_id, scopes, status')
      .eq('organization_id', orgId)

    const stripeInt = integrations?.find((i: { provider: string }) => i.provider === 'stripe') ?? null
    const hubspotInt = integrations?.find((i: { provider: string }) => i.provider === 'hubspot') ?? null

    return jsonResponse({
      stripe: buildIntegrationSummary(stripeInt, 'stripe'),
      hubspot: buildIntegrationSummary(hubspotInt, 'hubspot'),
    })
  }

  // ── POST /revoke ────────────────────────────────────────────
  if (raw === 'revoke' && req.method === 'POST') {
    let body: { provider?: string }
    try {
      body = await req.json()
    } catch {
      return errorResponse('Invalid JSON body', 400)
    }

    if (!body.provider || !isValidProvider(body.provider)) {
      return errorResponse('provider requis (stripe ou hubspot)', 400)
    }

    const provider = body.provider

    const { data: integration } = await supabase
      .from('organization_integrations')
      .select('id, vault_access_token_id, vault_refresh_token_id, provider_account_id, status')
      .eq('organization_id', orgId)
      .eq('provider', provider)
      .maybeSingle()

    if (!integration) {
      return errorResponse('Aucune integration trouvee pour ce provider', 404)
    }

    if (integration.status === 'revoked') {
      return jsonResponse({ success: true, message: 'Integration deja revoquee' })
    }

    // 1. Revoquer cote provider
    try {
      await revokeProviderToken(provider, integration, supabase)
    } catch {
      // La revocation echoue ? On continue — le token expirera de toute facon
      console.warn(`[integration-oauth] Provider revocation failed for ${provider}, continuing with local revocation`)
    }

    // 2. Supprimer les secrets du Vault
    try {
      if (integration.vault_access_token_id) {
        await deleteVaultSecret(supabase, integration.vault_access_token_id)
      }
      if (integration.vault_refresh_token_id) {
        await deleteVaultSecret(supabase, integration.vault_refresh_token_id)
      }
    } catch {
      // Vault cleanup failed — non-bloquant
    }

    // 3. Marquer comme revoque en DB (ne pas supprimer — audit trail)
    await supabase
      .from('organization_integrations')
      .update({ status: 'revoked', vault_access_token_id: null, vault_refresh_token_id: null })
      .eq('id', integration.id)

    // 4. Nettoyer les colonnes org si applicable
    if (provider === 'stripe') {
      await supabase
        .from('organizations')
        .update({ stripe_account_id: null })
        .eq('id', orgId)
    } else {
      await supabase
        .from('organizations')
        .update({ hubspot_portal_id: null })
        .eq('id', orgId)
    }

    return jsonResponse({ success: true, message: `Integration ${provider} revoquee` })
  }

  return errorResponse(`Route inconnue : /integration-oauth/${raw}`, 404)
})

// ── Callback handler (pas de JWT, protege par state CSRF) ─────

async function handleCallback(req: Request, provider: OAuthProvider): Promise<Response> {
  let supabase
  try {
    supabase = createServiceClient()
  } catch {
    return errorResponse('Server configuration error', 500)
  }

  const params = parseCallbackParams(req.url)
  if (!params) {
    return errorResponse('Parametres callback manquants (code, state)', 400)
  }

  if (params.error) {
    return errorResponse(`OAuth ${provider} refuse : ${params.error}`, 400)
  }

  // 1. Valider le state anti-CSRF
  const { data: storedState, error: stateError } = await supabase
    .from('oauth_states')
    .select('*')
    .eq('state', params.state)
    .eq('provider', provider)
    .maybeSingle()

  if (stateError || !storedState) {
    return errorResponse('State OAuth invalide ou inconnu', 400)
  }

  if (isStateExpired(storedState.expires_at)) {
    await supabase.from('oauth_states').delete().eq('id', storedState.id)
    return errorResponse('State OAuth expire (> 10 min). Reessayez la connexion.', 400)
  }

  const orgId = storedState.organization_id
  const redirectAfter = storedState.redirect_after

  // 2. Supprimer le state immediatement (usage unique)
  await supabase.from('oauth_states').delete().eq('id', storedState.id)

  // 3. Echanger le code contre les tokens
  try {
    if (provider === 'stripe') {
      await exchangeStripeCode(supabase, orgId, params.code)
    } else {
      await exchangeHubSpotCode(supabase, orgId, params.code)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return errorResponse(`Erreur lors de l'echange OAuth ${provider} : ${msg}`, 500)
  }

  // 4. Declencher le sync initial en fire-and-forget
  //    Le sync peut prendre 30-60s — ne pas bloquer le callback (Edge Function < 5s)
  //    On appelle sync-stripe/sync-hubspot via HTTP interne sans attendre la reponse.
  triggerInitialSync(provider, orgId)

  // 5. Redirect vers le frontend si redirect_after est fourni
  if (redirectAfter) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${redirectAfter}?provider=${provider}&status=connected` },
    })
  }

  return jsonResponse({ success: true, provider, status: 'connected' })
}

// ── Stripe token exchange ─────────────────────────────────────

async function exchangeStripeCode(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
  code: string,
): Promise<void> {
  const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY')
  if (!stripeSecretKey) throw new Error('STRIPE_SECRET_KEY not configured')

  const resp = await fetchWithTimeout(
    'https://connect.stripe.com/oauth/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_secret: stripeSecretKey,
      }),
    },
    10_000,
  )

  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`Stripe token exchange failed: ${resp.status} ${err}`)
  }

  const data = await resp.json()
  const accessToken = data.access_token as string
  const stripeUserId = data.stripe_user_id as string
  const scope = (data.scope as string) ?? STRIPE_SCOPES[0]

  // Stocker le access_token dans Vault
  const vaultAccessId = await storeVaultSecret(
    supabase,
    accessToken,
    `stripe_access_${orgId}`,
    `Stripe Connect access token for org ${orgId}`,
  )

  // Upsert organization_integrations
  await supabase
    .from('organization_integrations')
    .upsert({
      organization_id: orgId,
      provider: 'stripe',
      vault_access_token_id: vaultAccessId,
      vault_refresh_token_id: null, // Stripe Connect = long-lived
      token_expires_at: null,
      provider_account_id: stripeUserId,
      scopes: scope.split(' '),
      status: 'active',
    }, { onConflict: 'organization_id,provider' })

  // Mettre a jour organizations.stripe_account_id
  await supabase
    .from('organizations')
    .update({ stripe_account_id: stripeUserId })
    .eq('id', orgId)
}

// ── HubSpot token exchange ────────────────────────────────────

async function exchangeHubSpotCode(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
  code: string,
): Promise<void> {
  const clientId = Deno.env.get('HUBSPOT_CLIENT_ID')
  const clientSecret = Deno.env.get('HUBSPOT_CLIENT_SECRET')
  const redirectUri = Deno.env.get('HUBSPOT_OAUTH_REDIRECT_URI')
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('HubSpot OAuth env vars not configured')
  }

  const resp = await fetchWithTimeout(
    'https://api.hubapi.com/oauth/v1/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    },
    10_000,
  )

  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`HubSpot token exchange failed: ${resp.status} ${err}`)
  }

  const data = await resp.json()
  const accessToken = data.access_token as string
  const refreshToken = data.refresh_token as string
  const expiresIn = (data.expires_in as number) ?? 21600 // 6h par defaut

  // Stocker les tokens dans Vault
  const vaultAccessId = await storeVaultSecret(
    supabase,
    accessToken,
    `hubspot_access_${orgId}`,
    `HubSpot access token for org ${orgId}`,
  )

  const vaultRefreshId = await storeVaultSecret(
    supabase,
    refreshToken,
    `hubspot_refresh_${orgId}`,
    `HubSpot refresh token for org ${orgId}`,
  )

  // Recuperer le hub_id (portal ID) depuis l'API token info
  let hubId: string | null = null
  try {
    const infoResp = await fetchWithTimeout(
      `https://api.hubapi.com/oauth/v1/access-tokens/${accessToken}`,
      { method: 'GET' },
      8_000,
    )
    if (infoResp.ok) {
      const info = await infoResp.json()
      hubId = String(info.hub_id ?? '')
    }
  } catch {
    // Non-bloquant — le hub_id sera populate au prochain sync
  }

  // Upsert organization_integrations
  await supabase
    .from('organization_integrations')
    .upsert({
      organization_id: orgId,
      provider: 'hubspot',
      vault_access_token_id: vaultAccessId,
      vault_refresh_token_id: vaultRefreshId,
      token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      provider_account_id: hubId,
      scopes: [...HUBSPOT_SCOPES],
      status: 'active',
    }, { onConflict: 'organization_id,provider' })

  // Mettre a jour organizations.hubspot_portal_id
  if (hubId) {
    await supabase
      .from('organizations')
      .update({ hubspot_portal_id: hubId })
      .eq('id', orgId)
  }
}

// ── Provider token revocation ─────────────────────────────────

async function revokeProviderToken(
  provider: OAuthProvider,
  integration: {
    provider_account_id: string | null
    vault_access_token_id: string | null
  },
  supabase: ReturnType<typeof createServiceClient>,
): Promise<void> {
  if (provider === 'stripe') {
    const clientId = Deno.env.get('STRIPE_CONNECT_CLIENT_ID')
    const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY')
    if (!clientId || !stripeSecretKey || !integration.provider_account_id) return

    await fetchWithTimeout(
      'https://connect.stripe.com/oauth/deauthorize',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${stripeSecretKey}`,
        },
        body: new URLSearchParams({
          client_id: clientId,
          stripe_user_id: integration.provider_account_id,
        }),
      },
      10_000,
    )
  } else if (provider === 'hubspot') {
    if (!integration.vault_access_token_id) return

    const { getVaultSecret } = await import('../_shared/vault.ts')
    const token = await getVaultSecret(supabase, integration.vault_access_token_id)
    if (!token) return

    await fetchWithTimeout(
      `https://api.hubapi.com/oauth/v1/refresh-tokens/${token}`,
      { method: 'DELETE' },
      10_000,
    )
  }
}

// ── Trigger initial sync (fire-and-forget) ────────────────────
// Le sync peut prendre 30-60s — on ne bloque pas le callback.
// On appelle la Edge Function sync-stripe (ou sync-hubspot quand disponible)
// via HTTP interne. Pattern identique a self-monitor :
// - Log dans data_syncs (table persistante)
// - Alerte Slack sur echec

function triggerInitialSync(provider: OAuthProvider, orgId: string): void {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) return

  const functionName = provider === 'stripe' ? 'sync-stripe' : 'sync-hubspot'
  const url = `${supabaseUrl}/functions/v1/${functionName}`

  // Fire-and-forget : .then()/.catch() chain — jamais de await
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({
      organization_id: orgId,
      sync_type: 'initial',
    }),
  })
    .then(async (resp) => {
      // Logger le resultat dans data_syncs (table persistante)
      const svc = createServiceClient()
      if (resp.ok) {
        await svc.from('data_syncs').insert({
          organization_id: orgId,
          sync_source: provider === 'stripe' ? 'stripe' : 'hubspot',
          sync_type: 'initial',
          sync_status: 'completed',
          triggered_by: 'oauth_callback',
          is_manual: false,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          summary: { trigger: 'oauth_callback', function: functionName },
        })
      } else {
        const errorBody = await resp.text().catch(() => 'unknown')
        await svc.from('data_syncs').insert({
          organization_id: orgId,
          sync_source: provider === 'stripe' ? 'stripe' : 'hubspot',
          sync_type: 'initial',
          sync_status: 'failed',
          triggered_by: 'oauth_callback',
          is_manual: false,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          error_message: `Initial sync returned HTTP ${resp.status}: ${errorBody.substring(0, 200)}`,
          is_retryable: true,
        })
        await alertSlack(
          `Initial ${provider} sync failed for org ${orgId} after OAuth connect (HTTP ${resp.status}). Manual sync may be needed.`,
          { level: 'warning' },
        )
      }
    })
    .catch(async (err) => {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(JSON.stringify({
        level: 'error',
        function_name: 'integration-oauth',
        message: `Failed to trigger initial ${provider} sync`,
        organization_id: orgId,
        error: errorMsg,
      }))
      // Logger l'echec dans data_syncs si possible
      try {
        const svc = createServiceClient()
        await svc.from('data_syncs').insert({
          organization_id: orgId,
          sync_source: provider === 'stripe' ? 'stripe' : 'hubspot',
          sync_type: 'initial',
          sync_status: 'failed',
          triggered_by: 'oauth_callback',
          is_manual: false,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          error_message: `Failed to call ${functionName}: ${errorMsg}`,
          is_retryable: true,
        })
      } catch {
        // Last resort — si meme data_syncs echoue, on a deja le console.error
      }
      await alertSlack(
        `Initial ${provider} sync FAILED for org ${orgId}: ${errorMsg}. Connection succeeded but data not synced.`,
        { level: 'critical' },
      )
    })
}
