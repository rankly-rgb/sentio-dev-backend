// ============================================================
// Edge Function : playbook-outcome-detector
// Interne (service_role uniquement) — appelée en fire-and-forget
// par stripe-webhook après traitement de 'invoice.paid'.
// cf. specs/002-playbook-outcome-tracking/contracts/playbook-outcome-api.md
//
// NOTE (2026-07-27) : le hook fire-and-forget qui invoque cette
// fonction depuis stripe-webhook/index.ts (T015) est un point de
// gouvernance nécessitant une validation utilisateur explicite avant
// implémentation (cf. tasks.md) — NON câblé pour l'instant. Cette
// fonction est complète et testable de façon autonome, mais n'est
// encore appelée par aucun autre code du repo.
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'

interface DetectPayload {
  organization_id: string
  stripe_customer_id: string
}

// ── Entrypoint ──────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  let body: DetectPayload
  try {
    body = await req.json() as DetectPayload
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!body.organization_id || !body.stripe_customer_id) {
    return errorResponse('organization_id and stripe_customer_id are required', 400)
  }

  let supabase: SupabaseClient
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-outcome-detector', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  return handleDetect(supabase, body.organization_id, body.stripe_customer_id)
})

// ── Detection ───────────────────────────────────────────────

export async function handleDetect(
  supabase: SupabaseClient,
  organizationId: string,
  stripeCustomerId: string,
): Promise<Response> {
  const { data: account, error: accountError } = await supabase
    .from('accounts')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('stripe_customer_id', stripeCustomerId)
    .maybeSingle()

  if (accountError || !account) {
    return jsonResponse({ resolved_count: 0, reason: 'account_not_found' })
  }

  const nowIso = new Date().toISOString()

  // Exécutions en attente d'attribution — cf. data-model.md
  const { data: pending, error: pendingError } = await supabase
    .from('playbook_executions')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('account_id', account.id)
    .not('manual_executed_at', 'is', null)
    .eq('account_converted', false)
    .gt('attribution_deadline_at', nowIso)

  if (pendingError) {
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-outcome-detector', op: 'select_pending', message: pendingError.message }))
    return errorResponse('Failed to query pending executions', 500)
  }

  if (!pending?.length) {
    return jsonResponse({ resolved_count: 0 })
  }

  const ids = pending.map((p: { id: string }) => p.id)

  // FR-010 : plusieurs exécutions en attente pour le même compte → toutes résolues
  const { error: updateError } = await supabase
    .from('playbook_executions')
    .update({ account_converted: true, converted_at: nowIso, resolved_via: 'invoice_paid_auto' })
    .in('id', ids)

  if (updateError) {
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-outcome-detector', op: 'resolve', message: updateError.message }))
    return errorResponse('Failed to resolve executions', 500)
  }

  return jsonResponse({ resolved_count: ids.length })
}
