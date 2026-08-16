// ============================================================
// Edge Function : update-onboarding-step
// POST /update-onboarding-step
//
// Enregistre la progression comportementale de l'onboarding.
// Valide les transitions dans l'ordre défini (pas de saut).
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { withSentry } from '../_shared/sentry.ts'

// Ordre canonique des étapes — index = priorité
const STEP_ORDER = ['promise', 'stripe', 'revelation', 'invested', 'hubspot', 'completed'] as const
type OnboardingStep = typeof STEP_ORDER[number]

export function isValidTransition(current: string, next: string): boolean {
  const currentIdx = STEP_ORDER.indexOf(current as OnboardingStep)
  const nextIdx = STEP_ORDER.indexOf(next as OnboardingStep)
  if (currentIdx === -1 || nextIdx === -1) return false
  // Doit avancer d'au moins une étape, pas revenir en arrière
  // Interdit de sauter plus de 2 étapes (ex: promise → completed)
  return nextIdx > currentIdx && nextIdx <= currentIdx + 2
}

Deno.serve(withSentry('update-onboarding-step', async (req: Request): Promise<Response> => {
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

  let body: { step?: unknown }
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  const { step } = body
  if (!step || !STEP_ORDER.includes(step as OnboardingStep)) {
    return errorResponse(`step must be one of: ${STEP_ORDER.join(', ')}`, 400)
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'update-onboarding-step', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const orgId = auth.organizationId

  // Lire l'étape courante
  const { data: org, error: orgErr } = await supabase
    .from('organizations')
    .select('onboarding_step, onboarding_completed')
    .eq('id', orgId)
    .maybeSingle()

  if (orgErr || !org) {
    return errorResponse('Organization not found', 404)
  }

  const currentStep = org.onboarding_step ?? 'promise'
  const nextStep = step as OnboardingStep

  // Idempotent : même étape → pas d'erreur
  if (currentStep === nextStep) {
    return jsonResponse({ onboarding_step: currentStep, onboarding_completed: org.onboarding_completed })
  }

  if (!isValidTransition(currentStep, nextStep)) {
    return errorResponse(
      `Transition invalide : ${currentStep} → ${nextStep}. Respecter l'ordre des étapes.`,
      422,
    )
  }

  // Champs à mettre à jour
  const updates: Record<string, unknown> = { onboarding_step: nextStep }

  if (nextStep === 'promise') {
    updates.promise_seen_at = new Date().toISOString()
  }
  if (nextStep === 'revelation') {
    updates.first_revelation_at = new Date().toISOString()
  }
  if (nextStep === 'completed') {
    updates.onboarding_completed = true
  }

  const { error: updateErr } = await supabase
    .from('organizations')
    .update(updates)
    .eq('id', orgId)

  if (updateErr) {
    console.error(JSON.stringify({ level: 'error', function_name: 'update-onboarding-step', message: updateErr.message }))
    return errorResponse('Failed to update step', 500)
  }

  console.log(JSON.stringify({
    level: 'info',
    function_name: 'update-onboarding-step',
    organization_id: orgId,
    from: currentStep,
    to: nextStep,
  }))

  return jsonResponse({
    onboarding_step: nextStep,
    onboarding_completed: nextStep === 'completed',
  })
}))
