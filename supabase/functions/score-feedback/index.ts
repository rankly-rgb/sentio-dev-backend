// ============================================================
// Edge Function : score-feedback
// Capture le feedback produit (pouce haut/bas) sur un score ou un
// insight. Backend uniquement (chantier 7 — moitié de 5.9) : pas
// d'endpoint de lecture/liste, pas de widget UI (câblage frontend
// reporté).
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// POST /score-feedback
//   Auth : JWT utilisateur (ES256 via verifyUserAuth)
//   Body : { account_id: string, insight_id?: string, is_helpful: boolean }
//   Response 201 : { data: { id: string } }
//   Response 400 : { error: "..." }
//   Response 404 : { error: "Account not found" }
//
// Zero-PII : aucune colonne ne référence l'utilisateur ayant donné le
// feedback — uniquement account_id/insight_id/organization_id.
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { withSentry } from '../_shared/sentry.ts'

export interface ScoreFeedbackBody {
  account_id: string
  insight_id: string | null
  is_helpful: boolean
}

export type ValidationResult =
  | { valid: true; data: ScoreFeedbackBody }
  | { valid: false; error: string }

export function validateScoreFeedbackBody(body: unknown): ValidationResult {
  if (body === null || typeof body !== 'object') {
    return { valid: false, error: 'Body must be an object' }
  }

  const b = body as Record<string, unknown>

  if (typeof b.account_id !== 'string' || b.account_id.trim() === '') {
    return { valid: false, error: 'account_id is required' }
  }

  if (typeof b.is_helpful !== 'boolean') {
    return { valid: false, error: 'is_helpful must be a boolean' }
  }

  if (b.insight_id !== undefined && b.insight_id !== null && typeof b.insight_id !== 'string') {
    return { valid: false, error: 'insight_id must be a string if provided' }
  }

  return {
    valid: true,
    data: {
      account_id: b.account_id,
      insight_id: (b.insight_id as string | undefined) ?? null,
      is_helpful: b.is_helpful,
    },
  }
}

Deno.serve(withSentry('score-feedback', async (req: Request): Promise<Response> => {
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

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'score-feedback', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  const validation = validateScoreFeedbackBody(body)
  if (!validation.valid) {
    return errorResponse(validation.error, 400)
  }

  const orgId = auth.organizationId
  const { account_id, insight_id, is_helpful } = validation.data

  // Vérifie que le compte appartient bien à l'org de l'utilisateur (multi-tenant)
  const { data: account, error: accountError } = await supabase
    .from('accounts')
    .select('id')
    .eq('id', account_id)
    .eq('organization_id', orgId)
    .maybeSingle()

  if (accountError) {
    console.error(JSON.stringify({ level: 'error', function_name: 'score-feedback', message: accountError.message }))
    return errorResponse('Failed to verify account', 500)
  }

  if (!account) {
    return errorResponse('Account not found', 404)
  }

  const { data: inserted, error: insertError } = await supabase
    .from('score_feedback')
    .insert({
      organization_id: orgId,
      account_id,
      insight_id,
      is_helpful,
    })
    .select('id')
    .single()

  if (insertError) {
    console.error(JSON.stringify({ level: 'error', function_name: 'score-feedback', message: insertError.message }))
    return errorResponse('Failed to save feedback', 500)
  }

  return jsonResponse({ data: { id: inserted.id } }, 201)
}))
