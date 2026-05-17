// ============================================================
// Edge Function : track-usage
// POST /functions/v1/track-usage
// Ingère les événements d'usage produit (Zero-PII).
// Auth : X-Sentio-Webhook-Secret header — secret partagé par org,
//        stocké dans webhook_configs (provider='usage').
//        Identifie et scope l'org sans JWT.
// ============================================================
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'

const VALID_EVENT_TYPES = ['login', 'feature_used', 'api_call', 'export', 'report_viewed'] as const
const VALID_SOURCES = ['api', 'webhook', 'manual'] as const

type EventType = typeof VALID_EVENT_TYPES[number]
type SourceType = typeof VALID_SOURCES[number]

interface TrackUsagePayload {
  // Identifiant du compte — au moins l'un des deux obligatoire
  stripe_customer_id?: string
  account_id?: string

  event_type: EventType
  feature_name?: string
  event_count?: number
  event_date?: string   // ISO date YYYY-MM-DD, défaut = aujourd'hui
  source?: SourceType
  // organization_id retiré du payload de confiance : l'org est déduite du secret header
}

function isValidEventType(v: unknown): v is EventType {
  return typeof v === 'string' && (VALID_EVENT_TYPES as readonly string[]).includes(v)
}

function isValidSource(v: unknown): v is SourceType {
  return typeof v === 'string' && (VALID_SOURCES as readonly string[]).includes(v)
}

function isValidDate(v: unknown): boolean {
  if (typeof v !== 'string') return false
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v))
}

Deno.serve(async (req: Request): Promise<Response> => {
  // CORS preflight
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  // ── Authentification par secret partagé ──────────────────
  const webhookSecret = req.headers.get('X-Sentio-Webhook-Secret')
  if (!webhookSecret) {
    return errorResponse('Missing X-Sentio-Webhook-Secret header', 401)
  }

  // ── Parse payload ────────────────────────────────────────
  let payload: TrackUsagePayload
  try {
    payload = await req.json() as TrackUsagePayload
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  // ── Validation ───────────────────────────────────────────
  if (!payload.stripe_customer_id && !payload.account_id) {
    return errorResponse('stripe_customer_id or account_id is required', 400)
  }

  if (!isValidEventType(payload.event_type)) {
    return errorResponse(
      `event_type must be one of: ${VALID_EVENT_TYPES.join(', ')}`,
      400,
    )
  }

  const eventCount = payload.event_count ?? 1
  if (!Number.isInteger(eventCount) || eventCount < 1) {
    return errorResponse('event_count must be a positive integer', 400)
  }

  const eventDate = payload.event_date ?? new Date().toISOString().split('T')[0]
  if (!isValidDate(eventDate)) {
    return errorResponse('event_date must be a valid YYYY-MM-DD date', 400)
  }

  const source: SourceType = isValidSource(payload.source) ? payload.source : 'api'

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'track-usage', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  // ── Validation du secret + résolution de l'org ───────────
  const { data: webhookConfig, error: configError } = await supabase
    .from('webhook_configs')
    .select('organization_id')
    .eq('webhook_secret', webhookSecret)
    .eq('provider', 'usage')
    .eq('is_active', true)
    .maybeSingle()

  if (configError || !webhookConfig) {
    return errorResponse('Invalid or inactive webhook secret', 401)
  }

  // L'org est déduite du secret — le payload ne peut pas la forger
  const organizationId: string = webhookConfig.organization_id

  // ── Résolution du compte (scopé à l'org du secret) ───────
  let accountId: string | null = payload.account_id ?? null

  if (!accountId && payload.stripe_customer_id) {
    const { data, error } = await supabase
      .from('accounts')
      .select('id')
      .eq('stripe_customer_id', payload.stripe_customer_id)
      .eq('organization_id', organizationId)
      .maybeSingle()

    if (error || !data) {
      return errorResponse('Account not found for stripe_customer_id', 404)
    }
    accountId = data.id
  } else if (accountId) {
    const { data, error } = await supabase
      .from('accounts')
      .select('id')
      .eq('id', accountId)
      .eq('organization_id', organizationId)
      .maybeSingle()

    if (error || !data) {
      return errorResponse('Account not found', 404)
    }
  }

  if (!accountId) {
    return errorResponse('Cannot resolve account', 400)
  }

  // ── Insertion de l'événement ─────────────────────────────
  const { error: insertError } = await supabase
    .from('usage_events')
    .insert({
      organization_id: organizationId,
      account_id: accountId,
      event_type: payload.event_type,
      feature_name: payload.feature_name ?? null,
      event_count: eventCount,
      event_date: eventDate,
      source,
    })

  if (insertError) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'track-usage',
      message: 'insert error',
      error: insertError.message,
      account_id: accountId,
      event_type: payload.event_type,
    }))
    return errorResponse('Failed to record usage event', 500)
  }

  return jsonResponse({
    success: true,
    account_id: accountId,
    event_type: payload.event_type,
    event_date: eventDate,
    event_count: eventCount,
  }, 201)
})
