// ============================================================
// Edge Function : playbook-link
// GET /playbook-link/{execution_id}
// Lien traçable public : log de clic Zero-PII + redirection 302.
// cf. specs/002-playbook-outcome-tracking/contracts/playbook-outcome-api.md
//
// Sécurité anti-open-redirect (T022, validé 2026-07-27) : la requête
// entrante ne porte AUCUN paramètre de destination — `execution_id` ne
// sert qu'à un SELECT. La destination est résolue exclusivement côté
// serveur depuis `playbooks.link_redirect_url` (configurée à l'écriture
// par playbook-crud, jamais au moment du clic), avec repli sur
// NEXT_PUBLIC_APP_URL — jamais une valeur dérivée de la requête.
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse } from '../_shared/supabase-client.ts'

const DEFAULT_REDIRECT_URL = 'https://app.sentioapp.io'

// ── Entrypoint ──────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'GET') return errorResponse('Method not allowed', 405)

  const url = new URL(req.url)
  const segments = url.pathname.split('/').filter(Boolean)
  const fnIndex = segments.indexOf('playbook-link')
  const executionId = fnIndex >= 0 ? segments[fnIndex + 1] : undefined

  if (!executionId) return errorResponse('execution_id path parameter required', 400)

  let supabase: SupabaseClient
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-link', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  return handleLinkVisit(supabase, executionId)
})

// ── Visite du lien ──────────────────────────────────────────

export async function handleLinkVisit(
  supabase: SupabaseClient,
  executionId: string,
): Promise<Response> {
  // 1. Vérifier l'existence de l'exécution — 404 sans fuite d'info sur l'organisation.
  const { data: execution, error } = await supabase
    .from('playbook_executions')
    .select('id, organization_id, playbook_id, stripe_customer_id')
    .eq('id', executionId)
    .maybeSingle()

  if (error || !execution) return errorResponse('Not found', 404)

  // 2. Logger le clic — Zero-PII, jamais dédupliqué (US3).
  const { error: clickError } = await supabase
    .from('playbook_execution_clicks')
    .insert({
      organization_id: execution.organization_id,
      playbook_execution_id: execution.id,
      stripe_customer_id: execution.stripe_customer_id,
    })

  if (clickError) {
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-link', op: 'log_click', message: clickError.message }))
    // Le clic ne doit jamais bloquer la redirection — on continue.
  }

  // 3. Résoudre la destination — EXCLUSIVEMENT côté serveur, jamais depuis la requête.
  const { data: playbook } = await supabase
    .from('playbooks')
    .select('link_redirect_url')
    .eq('id', execution.playbook_id)
    .maybeSingle()

  const destination = playbook?.link_redirect_url ?? Deno.env.get('NEXT_PUBLIC_APP_URL') ?? DEFAULT_REDIRECT_URL

  return new Response(null, {
    status: 302,
    headers: {
      Location: destination,
      'Access-Control-Allow-Origin': '*',
    },
  })
}
