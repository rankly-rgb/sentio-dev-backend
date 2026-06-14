// ============================================================
// Edge Function : playbook-templates
// Expose les templates V1 définis dans playbook-engine.ts.
// Pas de requête DB — les templates sont des constantes TypeScript.
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { PLAYBOOK_TEMPLATES_V1 } from '../_shared/playbook-engine.ts'

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  try {
    await verifyUserAuth(req)
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.message, err.status)
    return errorResponse('Authentication failed', 401)
  }

  if (req.method !== 'GET') return errorResponse('Method not allowed', 405)

  const url = new URL(req.url)
  const locale: 'fr' | 'en' = url.searchParams.get('locale') === 'en' ? 'en' : 'fr'

  const templates = PLAYBOOK_TEMPLATES_V1.map((t) => ({
    id: t.id,
    title: locale === 'en' ? t.title_en : t.title_fr,
    description: locale === 'en' ? t.description_en : t.description_fr,
    playbook_type: t.playbook_type,
    template_category: t.template_category,
    priority: t.priority,
    is_automated: t.is_automated,
    trigger_conditions: t.trigger_conditions,
    actions: t.actions,
  }))

  return jsonResponse({
    data: {
      templates,
      locale,
      total: templates.length,
    },
  })
})
