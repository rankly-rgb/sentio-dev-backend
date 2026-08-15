// ============================================================
// Edge Function : org-settings
// Lit et met à jour les paramètres de l'organisation.
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// GET /org-settings
//   Response 200 :
//     {
//       data: {
//         locale: 'fr' | 'en',
//         translations: Record<string, string>  // dictionnaire complet pour la locale active
//       }
//     }
//
// PATCH /org-settings
//   Body : { locale: 'fr' | 'en' }
//   Response 200 : { success: true }
//
// Auth : JWT utilisateur vérifié dans le code (ES256 via verifyUserAuth)
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { type Lang, getTranslationDict } from '../_shared/translations.ts'

const SUPPORTED_LOCALES = ['fr', 'en'] as const
type Locale = typeof SUPPORTED_LOCALES[number]

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  let auth
  try {
    auth = await verifyUserAuth(req)
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.message, err.status)
    return errorResponse('Authentication failed', 401)
  }

  const { organizationId } = auth

  let supabase
  try {
    supabase = createServiceClient()
  } catch {
    return errorResponse('Service unavailable', 503)
  }

  // ── GET ────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data: org, error } = await supabase
      .from('organizations')
      .select('locale')
      .eq('id', organizationId)
      .maybeSingle()

    if (error) return errorResponse('Failed to fetch settings', 500)
    if (!org) return errorResponse('Organization not found', 404)

    const locale: Lang = (org.locale ?? 'fr') as Lang

    return jsonResponse({
      data: {
        locale,
        translations: getTranslationDict(locale),
      },
    })
  }

  // ── PATCH ──────────────────────────────────────────────
  if (req.method === 'PATCH') {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return errorResponse('Invalid JSON body', 400)
    }

    const parsed = validatePatchBody(body)
    if (!parsed.ok) return errorResponse(parsed.error, 400)

    const { error } = await supabase
      .from('organizations')
      .update({ locale: parsed.locale })
      .eq('id', organizationId)

    if (error) return errorResponse('Failed to update settings', 500)

    return jsonResponse({ success: true })
  }

  return errorResponse('Method not allowed', 405)
})

// ── Validation ─────────────────────────────────────────────

type ParseOk = { ok: true; locale: Locale }
type ParseErr = { ok: false; error: string }

export function validatePatchBody(body: unknown): ParseOk | ParseErr {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object' }
  }

  const b = body as Record<string, unknown>

  if (!('locale' in b)) {
    return { ok: false, error: 'Missing field: locale' }
  }

  if (!SUPPORTED_LOCALES.includes(b.locale as Locale)) {
    return { ok: false, error: `locale must be one of: ${SUPPORTED_LOCALES.join(', ')}` }
  }

  return { ok: true, locale: b.locale as Locale }
}
