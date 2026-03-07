// ============================================================
// Edge Function : configure-webhook
// CRUD pour la configuration du webhook sortant d'une organisation
// GET : config actuelle (secret masqué)
// POST : créer ou mettre à jour
// DELETE : désactiver (soft delete)
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'

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

  // ── GET : retourner la config actuelle ────────────────────
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

  // ── DELETE : désactiver le webhook ────────────────────────
  if (req.method === 'DELETE') {
    const { error } = await supabase
      .from('webhook_configs')
      .update({ is_active: false })
      .eq('organization_id', orgId)
      .eq('provider', 'webhook')

    if (error) return errorResponse('Erreur lors de la désactivation', 500)

    return jsonResponse({ success: true, message: 'Webhook désactivé' })
  }

  // ── POST : créer ou mettre à jour ─────────────────────────
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  let body: { endpoint_url?: string; active_events?: string[] }
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  // Validate endpoint_url
  if (!body.endpoint_url || !isValidHttpsUrl(body.endpoint_url)) {
    return errorResponse('endpoint_url doit être une URL HTTPS valide', 400)
  }

  // Validate active_events
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

  // Check if config already exists
  const { data: existing } = await supabase
    .from('webhook_configs')
    .select('id, webhook_secret')
    .eq('organization_id', orgId)
    .eq('provider', 'webhook')
    .maybeSingle()

  if (existing) {
    // Update existing config
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

  // Create new config — generate secret, return it in clear ONCE
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
})
