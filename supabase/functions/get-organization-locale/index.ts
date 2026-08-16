// ============================================================
// Edge Function : get-organization-locale
// GET /get-organization-locale
//
// Retourne la locale de l'organisation appelante.
// Utilisé au chargement de l'app pour hydrater le contexte locale.
//
// Response 200 : { locale: 'fr' | 'en' }
// Auth : JWT utilisateur (ES256 via verifyUserAuth)
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { withSentry } from '../_shared/sentry.ts'

Deno.serve(withSentry('get-organization-locale', async (req: Request): Promise<Response> => {
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
  } catch {
    return errorResponse('Service unavailable', 503)
  }

  const { data: org, error } = await supabase
    .from('organizations')
    .select('locale')
    .eq('id', auth.organizationId)
    .maybeSingle()

  if (error) return errorResponse('Failed to fetch locale', 500)
  if (!org) return errorResponse('Organization not found', 404)

  const locale: 'fr' | 'en' = (org.locale === 'en') ? 'en' : 'fr'

  return jsonResponse({ locale })
}))
