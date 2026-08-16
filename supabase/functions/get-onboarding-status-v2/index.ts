// ============================================================
// Edge Function : get-onboarding-status-v2
// GET /get-onboarding-status-v2
//
// Snapshot complet de l'état d'onboarding comportemental.
// Appelée au chargement de chaque page protégée.
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

  const [orgRes, demoCountRes] = await Promise.all([
    supabase
      .from('organizations')
      .select('id, onboarding_step, onboarding_completed, promise_seen_at, first_revelation_at')
      .eq('id', orgId)
      .maybeSingle(),
    supabase
      .from('accounts')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('is_demo', true),
  ])

  if (orgRes.error || !orgRes.data) {
    return errorResponse('Organization not found', 404)
  }

  const org = orgRes.data

  return jsonResponse({
    organization_id: org.id,
    onboarding_step: org.onboarding_step ?? 'promise',
    onboarding_completed: org.onboarding_completed ?? false,
    has_demo_data: (demoCountRes.count ?? 0) > 0,
    promise_seen: org.promise_seen_at !== null,
    first_revelation_done: org.first_revelation_at !== null,
  })
}))
