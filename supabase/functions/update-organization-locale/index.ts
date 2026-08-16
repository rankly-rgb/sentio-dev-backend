// ============================================================
// Edge Function : update-organization-locale
// PATCH /update-organization-locale
//
// Met à jour la locale de l'organisation appelante.
//
// Body   : { locale: 'fr' | 'en' }
// Response 200 : { success: true, locale: 'fr' | 'en' }
// Auth : JWT utilisateur (ES256 via verifyUserAuth)
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { withSentry } from '../_shared/sentry.ts'

const VALID_LOCALES = ['fr', 'en'] as const
type Locale = typeof VALID_LOCALES[number]

Deno.serve(withSentry('update-organization-locale', async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'PATCH') return errorResponse('Method not allowed', 405)

  let auth
  try {
    auth = await verifyUserAuth(req)
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.message, err.status)
    return errorResponse('Authentication failed', 401)
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('Body must be a JSON object', 400)
  }

  const b = body as Record<string, unknown>

  if (!('locale' in b)) {
    return errorResponse('Missing field: locale', 400)
  }

  if (!VALID_LOCALES.includes(b.locale as Locale)) {
    return errorResponse(`locale must be one of: ${VALID_LOCALES.join(', ')}`, 400)
  }

  const locale = b.locale as Locale

  let supabase
  try {
    supabase = createServiceClient()
  } catch {
    return errorResponse('Service unavailable', 503)
  }

  const { error } = await supabase
    .from('organizations')
    .update({ locale })
    .eq('id', auth.organizationId)

  if (error) return errorResponse('Failed to update locale', 500)

  return jsonResponse({ success: true, locale })
}))
