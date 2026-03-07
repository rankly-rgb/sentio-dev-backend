// ============================================================
// Edge Function : webhook-config
// Gestion complète du webhook sortant d'une organisation
//
// Routes :
//   GET  /webhook-config          — Config actuelle (secret masqué)
//   POST /webhook-config          — Créer ou mettre à jour
//   POST /webhook-config/test     — Envoyer un webhook de test
//   POST /webhook-config/regenerate-secret — Régénérer le secret HMAC
//   POST /webhook-config/disable  — Désactiver le webhook
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { computeHmacSignature } from '../_shared/webhook-dispatcher.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'

const VALID_EVENTS = [
  'churn_risk_critical',
  'payment_failed',
  'renewal_reminder',
  'expansion_opportunity',
  'health_score_drop',
  'onboarding_completed',
] as const

function maskSecret(secret: string): string {
  if (secret.length <= 8) return '********'
  return secret.substring(0, 8) + '...'
}

function isValidHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function getSubPath(req: Request): string {
  const url = new URL(req.url)
  // Supabase Edge Functions: path = /webhook-config/... or /functions/v1/webhook-config/...
  const match = url.pathname.match(/\/webhook-config\/(.+)/)
  return match ? match[1] : ''
}

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  // Auth
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
  const subPath = getSubPath(req)

  // ── POST /webhook-config/test ─────────────────────────────
  if (subPath === 'test' && req.method === 'POST') {
    const { data: config, error: cfgError } = await supabase
      .from('webhook_configs')
      .select('endpoint_url, webhook_secret')
      .eq('organization_id', orgId)
      .eq('provider', 'webhook')
      .maybeSingle()

    if (cfgError || !config || !config.endpoint_url) {
      return errorResponse('Aucune configuration webhook trouvée', 404)
    }

    const testPayload = {
      event: 'test' as const,
      test: true,
      triggered_at: new Date().toISOString(),
      organization_id: orgId,
      account: {
        account_id: '00000000-0000-0000-0000-000000000000',
        stripe_customer_id: 'cus_TEST_sentio_demo',
      },
      signals: {
        health_score: 28,
        churn_risk_score: 84,
        expansion_score: 12,
        mrr_cents: 49900,
        trigger_reason: 'Test de connexion Sentio AI',
      },
    }

    const payloadStr = JSON.stringify(testPayload)
    const signature = await computeHmacSignature(payloadStr, config.webhook_secret)
    const timestamp = Math.floor(Date.now() / 1000).toString()

    const startTime = Date.now()
    let statusCode = 0
    let success = false
    let errorMessage: string | undefined

    try {
      const resp = await fetchWithTimeout(
        config.endpoint_url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Sentio-Event': 'test',
            'X-Sentio-Signature': signature,
            'X-Sentio-Timestamp': timestamp,
            'X-Sentio-Version': '1',
          },
          body: payloadStr,
        },
        10_000,
      )
      statusCode = resp.status
      success = resp.ok
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err)
    }

    const latencyMs = Date.now() - startTime

    return jsonResponse({
      success,
      status_code: statusCode,
      latency_ms: latencyMs,
      ...(errorMessage ? { error_message: errorMessage } : {}),
    })
  }

  // ── POST /webhook-config/regenerate-secret ────────────────
  if (subPath === 'regenerate-secret' && req.method === 'POST') {
    const { data: existing } = await supabase
      .from('webhook_configs')
      .select('id')
      .eq('organization_id', orgId)
      .eq('provider', 'webhook')
      .maybeSingle()

    if (!existing) {
      return errorResponse('Aucune configuration webhook trouvée', 404)
    }

    const newSecret = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    const { error: updateError } = await supabase
      .from('webhook_configs')
      .update({ webhook_secret: newSecret, failure_count: 0 })
      .eq('id', existing.id)

    if (updateError) {
      return errorResponse('Erreur lors de la régénération du secret', 500)
    }

    try {
      await supabase.from('data_syncs').insert({
        organization_id: orgId,
        sync_source: 'manual',
        sync_type: 'webhook',
        sync_status: 'completed',
        triggered_by: 'manual',
        records_processed: 1,
        summary: { action: 'webhook_secret_regenerated' },
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      })
    } catch {
      // Audit log failure must not crash the response
    }

    return jsonResponse({
      success: true,
      message: 'Secret régénéré avec succès',
      secret: newSecret,
    })
  }

  // ── POST /webhook-config/disable ──────────────────────────
  if (subPath === 'disable' && req.method === 'POST') {
    const { error } = await supabase
      .from('webhook_configs')
      .update({ is_active: false })
      .eq('organization_id', orgId)
      .eq('provider', 'webhook')

    if (error) return errorResponse('Erreur lors de la désactivation', 500)

    return jsonResponse({ success: true, message: 'Webhook désactivé' })
  }

  // ── Reject unknown sub-paths ──────────────────────────────
  if (subPath) {
    return errorResponse(`Route inconnue : /webhook-config/${subPath}`, 404)
  }

  // ── GET /webhook-config — Config actuelle ─────────────────
  if (req.method === 'GET') {
    const { data: config, error } = await supabase
      .from('webhook_configs')
      .select('id, endpoint_url, webhook_secret, active_events, is_active, last_triggered_at, failure_count, created_at, updated_at')
      .eq('organization_id', orgId)
      .eq('provider', 'webhook')
      .maybeSingle()

    if (error) return errorResponse('Erreur lors de la récupération de la configuration', 500)
    if (!config) return jsonResponse({ configured: false })

    return jsonResponse({
      configured: true,
      id: config.id,
      endpoint_url: config.endpoint_url,
      secret_preview: maskSecret(config.webhook_secret),
      active_events: config.active_events,
      is_active: config.is_active,
      last_triggered_at: config.last_triggered_at,
      failure_count: config.failure_count,
      created_at: config.created_at,
      updated_at: config.updated_at,
    })
  }

  // ── POST /webhook-config — Créer ou mettre à jour ─────────
  if (req.method === 'POST') {
    let body: { endpoint_url?: string; active_events?: string[] }
    try {
      body = await req.json()
    } catch {
      return errorResponse('Invalid JSON body', 400)
    }

    if (!body.endpoint_url || !isValidHttpsUrl(body.endpoint_url)) {
      return errorResponse('endpoint_url doit être une URL HTTPS valide', 400)
    }

    if (body.active_events) {
      if (!Array.isArray(body.active_events)) {
        return errorResponse('active_events doit être un tableau', 400)
      }
      const invalidEvents = body.active_events.filter(
        (e: string) => !VALID_EVENTS.includes(e as typeof VALID_EVENTS[number]),
      )
      if (invalidEvents.length > 0) {
        return errorResponse(`Événements invalides : ${invalidEvents.join(', ')}`, 400)
      }
    }

    const { data: existing } = await supabase
      .from('webhook_configs')
      .select('id, webhook_secret')
      .eq('organization_id', orgId)
      .eq('provider', 'webhook')
      .maybeSingle()

    if (existing) {
      const updateData: Record<string, unknown> = {
        endpoint_url: body.endpoint_url,
        is_active: true,
        failure_count: 0,
      }
      if (body.active_events) {
        updateData.active_events = body.active_events
      }

      const { error: updateError } = await supabase
        .from('webhook_configs')
        .update(updateData)
        .eq('id', existing.id)

      if (updateError) return errorResponse('Erreur lors de la mise à jour', 500)

      return jsonResponse({
        success: true,
        message: 'Configuration webhook mise à jour',
        id: existing.id,
        secret_preview: maskSecret(existing.webhook_secret),
      })
    }

    const newSecret = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    const { data: created, error: createError } = await supabase
      .from('webhook_configs')
      .insert({
        organization_id: orgId,
        provider: 'webhook',
        webhook_secret: newSecret,
        endpoint_url: body.endpoint_url,
        active_events: body.active_events ?? VALID_EVENTS,
        is_active: true,
        failure_count: 0,
      })
      .select('id')
      .single()

    if (createError || !created) {
      return errorResponse('Erreur lors de la création de la configuration', 500)
    }

    return jsonResponse({
      success: true,
      message: 'Configuration webhook créée',
      id: created.id,
      secret: newSecret,
    }, 201)
  }

  return errorResponse('Method not allowed', 405)
})
