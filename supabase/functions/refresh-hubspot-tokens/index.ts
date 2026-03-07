// ============================================================
// Edge Function : refresh-hubspot-tokens
// Cron toutes les 5h — rafraichit les tokens HubSpot (TTL 6h)
// avant expiration. Buffer de 1h pour eviter les expirations
// entre deux executions du cron.
//
// Auth : service_role uniquement (verify_jwt = true)
// ============================================================
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { acquireCronLock, releaseCronLock } from '../_shared/cron-lock.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'
import { retryWithBackoff } from '../_shared/retry-with-backoff.ts'
import { alertSlack } from '../_shared/slack-alert.ts'
import { getVaultSecret, updateVaultSecret, storeVaultSecret } from '../_shared/vault.ts'

const LOCK_KEY = 'refresh-hubspot-tokens'
const TOKEN_BUFFER_MS = 60 * 60 * 1000 // 1h — refresh si expire dans < 1h

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: LOCK_KEY, message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const locked = await acquireCronLock(supabase, LOCK_KEY, 120)
  if (!locked) {
    return jsonResponse({ skipped: true, reason: 'lock_held' })
  }

  try {
    // Recuperer toutes les integrations HubSpot actives avec un refresh token
    const { data: integrations, error: queryError } = await supabase
      .from('organization_integrations')
      .select('id, organization_id, vault_access_token_id, vault_refresh_token_id, token_expires_at')
      .eq('provider', 'hubspot')
      .eq('status', 'active')
      .not('vault_refresh_token_id', 'is', null)

    if (queryError) {
      throw new Error(`Failed to query integrations: ${queryError.message}`)
    }

    if (!integrations || integrations.length === 0) {
      return jsonResponse({ refreshed: 0, message: 'No HubSpot integrations to refresh' })
    }

    const clientId = Deno.env.get('HUBSPOT_CLIENT_ID')
    const clientSecret = Deno.env.get('HUBSPOT_CLIENT_SECRET')
    if (!clientId || !clientSecret) {
      throw new Error('HUBSPOT_CLIENT_ID or HUBSPOT_CLIENT_SECRET not configured')
    }

    let refreshed = 0
    let skipped = 0
    let failed = 0

    for (const integration of integrations) {
      // Verifier si le token expire bientot
      if (integration.token_expires_at) {
        const expiresAt = new Date(integration.token_expires_at).getTime()
        if (expiresAt - Date.now() > TOKEN_BUFFER_MS) {
          skipped++
          continue // Token encore valide, pas besoin de refresh
        }
      }

      try {
        // Lire le refresh_token depuis Vault
        const refreshToken = await getVaultSecret(supabase, integration.vault_refresh_token_id)
        if (!refreshToken) {
          console.error(JSON.stringify({
            level: 'error',
            function_name: LOCK_KEY,
            message: 'Refresh token not found in Vault',
            organization_id: integration.organization_id,
          }))
          failed++
          continue
        }

        // Appeler HubSpot pour rafraichir
        const resp = await retryWithBackoff(
          () => fetchWithTimeout(
            'https://api.hubapi.com/oauth/v1/token',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken,
              }),
            },
            10_000,
          ),
          3,
        )

        if (!resp.ok) {
          const errBody = await resp.text().catch(() => 'unknown')
          throw new Error(`HubSpot refresh failed: ${resp.status} ${errBody.substring(0, 200)}`)
        }

        const data = await resp.json()
        const newAccessToken = data.access_token as string
        const newRefreshToken = data.refresh_token as string
        const expiresIn = (data.expires_in as number) ?? 21600

        // Mettre a jour les tokens dans Vault
        if (integration.vault_access_token_id) {
          await updateVaultSecret(supabase, integration.vault_access_token_id, newAccessToken)
        } else {
          const vaultId = await storeVaultSecret(
            supabase,
            newAccessToken,
            `hubspot_access_${integration.organization_id}`,
            `HubSpot access token for org ${integration.organization_id}`,
          )
          await supabase
            .from('organization_integrations')
            .update({ vault_access_token_id: vaultId })
            .eq('id', integration.id)
        }

        // HubSpot retourne un nouveau refresh_token a chaque refresh
        await updateVaultSecret(supabase, integration.vault_refresh_token_id, newRefreshToken)

        // Mettre a jour token_expires_at
        await supabase
          .from('organization_integrations')
          .update({
            token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
          })
          .eq('id', integration.id)

        refreshed++
        console.log(JSON.stringify({
          level: 'info',
          function_name: LOCK_KEY,
          message: 'Token refreshed successfully',
          organization_id: integration.organization_id,
        }))
      } catch (err) {
        failed++
        const msg = err instanceof Error ? err.message : String(err)
        console.error(JSON.stringify({
          level: 'error',
          function_name: LOCK_KEY,
          message: 'Token refresh failed',
          organization_id: integration.organization_id,
          error: msg,
        }))

        // Marquer l'integration comme expired si le refresh echoue
        await supabase
          .from('organization_integrations')
          .update({ status: 'expired' })
          .eq('id', integration.id)

        await alertSlack(
          `HubSpot token refresh failed for org ${integration.organization_id}: ${msg}. Integration marked as expired.`,
          { level: 'critical' },
        )
      }
    }

    const summary = { refreshed, skipped, failed, total: integrations.length }
    console.log(JSON.stringify({
      level: 'info',
      function_name: LOCK_KEY,
      message: 'Token refresh cycle complete',
      ...summary,
    }))

    return jsonResponse(summary)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: LOCK_KEY, message: msg }))
    await alertSlack(`refresh-hubspot-tokens cron failed: ${msg}`, { level: 'critical' })
    return jsonResponse({ error: msg }, 500)
  } finally {
    try { await releaseCronLock(supabase, LOCK_KEY) } catch { /* safety */ }
  }
})
