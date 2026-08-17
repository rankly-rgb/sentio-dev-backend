// ============================================================
// Edge Function : get-onboarding-status-v2
// GET /get-onboarding-status-v2
//
// Snapshot complet de l'état d'onboarding comportemental.
// Appelée au chargement de chaque page protégée.
//
// 2026-08-17 : `has_demo_data` retiré — la requête `accounts.is_demo`
// ciblait une colonne qui n'a jamais existé (vérifié en direct), donc
// échouait silencieusement à chaque appel (demoCountRes.error jamais
// vérifié, `.count` retombait à `null` → `has_demo_data` toujours
// `false`). Voir create-organization-with-invitation, même chantier :
// le seed qui aurait pu un jour rendre ce champ vrai n'a jamais
// fonctionné non plus.
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { withSentry } from '../_shared/sentry.ts'

Deno.serve(withSentry('get-onboarding-status-v2', async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'GET') return errorResponse('Method not allowed', 405)

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
    console.error(JSON.stringify({ level: 'error', function_name: 'get-onboarding-status-v2', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const orgId = auth.organizationId

  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .select('id, onboarding_step, onboarding_completed, promise_seen_at, first_revelation_at')
    .eq('id', orgId)
    .maybeSingle()

  if (orgError || !org) {
    return errorResponse('Organization not found', 404)
  }

  return jsonResponse({
    organization_id: org.id,
    onboarding_step: org.onboarding_step ?? 'promise',
    onboarding_completed: org.onboarding_completed ?? false,
    promise_seen: org.promise_seen_at !== null,
    first_revelation_done: org.first_revelation_at !== null,
  })
}))
