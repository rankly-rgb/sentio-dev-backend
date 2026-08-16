// ============================================================
// Edge Function : save-org-preferences
// POST /save-org-preferences
//
// Enregistre les personnalisations de l'utilisateur (investissement
// utilisateur — principe Eyal/Hooked). Déclenche la transition
// onboarding_step → 'invested' si l'étape le permet.
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { withSentry } from '../_shared/sentry.ts'

const VALID_ALERT_CHANNELS = ['none', 'slack', 'email', 'both'] as const

// Étapes depuis lesquelles on peut passer à 'invested'
const INVESTABLE_STEPS = new Set(['stripe', 'revelation'])

Deno.serve(withSentry('save-org-preferences', async (req: Request): Promise<Response> => {
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

  let body: {
    danger_threshold?: unknown
    at_risk_threshold?: unknown
    champion_threshold?: unknown
    segment_name_champions?: unknown
    segment_name_at_risk?: unknown
    segment_name_danger?: unknown
    segment_name_stable?: unknown
    alert_channel?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  // Validation des seuils
  const { danger_threshold, at_risk_threshold, champion_threshold, alert_channel } = body

  if (danger_threshold !== undefined) {
    const v = Number(danger_threshold)
    if (!Number.isInteger(v) || v < 10 || v > 60) return errorResponse('danger_threshold must be between 10 and 60', 400)
  }
  if (at_risk_threshold !== undefined) {
    const v = Number(at_risk_threshold)
    if (!Number.isInteger(v) || v < 30 || v > 80) return errorResponse('at_risk_threshold must be between 30 and 80', 400)
  }
  if (champion_threshold !== undefined) {
    const v = Number(champion_threshold)
    if (!Number.isInteger(v) || v < 60 || v > 100) return errorResponse('champion_threshold must be between 60 and 100', 400)
  }
  if (alert_channel !== undefined && !VALID_ALERT_CHANNELS.includes(alert_channel as typeof VALID_ALERT_CHANNELS[number])) {
    return errorResponse(`alert_channel must be one of: ${VALID_ALERT_CHANNELS.join(', ')}`, 400)
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'save-org-preferences', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const orgId = auth.organizationId

  // Construire le payload UPSERT (uniquement les champs fournis)
  const upsertData: Record<string, unknown> = { organization_id: orgId }

  if (danger_threshold !== undefined)         upsertData.danger_threshold = Number(danger_threshold)
  if (at_risk_threshold !== undefined)        upsertData.at_risk_threshold = Number(at_risk_threshold)
  if (champion_threshold !== undefined)       upsertData.champion_threshold = Number(champion_threshold)
  if (body.segment_name_champions !== undefined) upsertData.segment_name_champions = String(body.segment_name_champions)
  if (body.segment_name_at_risk !== undefined)   upsertData.segment_name_at_risk = String(body.segment_name_at_risk)
  if (body.segment_name_danger !== undefined)    upsertData.segment_name_danger = String(body.segment_name_danger)
  if (body.segment_name_stable !== undefined)    upsertData.segment_name_stable = String(body.segment_name_stable)
  if (alert_channel !== undefined)            upsertData.alert_channel = String(alert_channel)

  const { error: upsertErr } = await supabase
    .from('org_preferences')
    .upsert(upsertData, { onConflict: 'organization_id' })

  if (upsertErr) {
    console.error(JSON.stringify({ level: 'error', function_name: 'save-org-preferences', message: upsertErr.message }))
    return errorResponse('Failed to save preferences', 500)
  }

  // Lire l'étape courante pour savoir s'il faut avancer vers 'invested'
  const { data: org } = await supabase
    .from('organizations')
    .select('onboarding_step')
    .eq('id', orgId)
    .maybeSingle()

  const currentStep = org?.onboarding_step ?? 'promise'
  let newStep = currentStep

  if (INVESTABLE_STEPS.has(currentStep)) {
    const { error: stepErr } = await supabase
      .from('organizations')
      .update({ onboarding_step: 'invested' })
      .eq('id', orgId)

    if (!stepErr) {
      newStep = 'invested'
      console.log(JSON.stringify({
        level: 'info',
        function_name: 'save-org-preferences',
        organization_id: orgId,
        step_transition: `${currentStep} → invested`,
      }))
    }
  }

  return jsonResponse({
    saved: true,
    onboarding_step: newStep,
  })
}))
