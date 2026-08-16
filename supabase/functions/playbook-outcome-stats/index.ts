// ============================================================
// Edge Function : playbook-outcome-stats
// GET /playbook-outcome-stats?playbook_id={uuid}
// Taux de résolution exécuté vs non-exécuté, avec taille d'échantillon.
// cf. API_CONTRACTS.md § 8.3
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { withSentry } from '../_shared/sentry.ts'

const SAMPLE_SIZE_WARNING_THRESHOLD = 20

interface GroupStats {
  sample_size: number
  resolved_count: number
  resolution_rate: number | null
  sample_size_warning: boolean
}

// ── Entrypoint ──────────────────────────────────────────────

Deno.serve(withSentry('playbook-outcome-stats', async (req: Request): Promise<Response> => {
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

  let supabase: SupabaseClient
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-outcome-stats', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const url = new URL(req.url)
  const playbookId = url.searchParams.get('playbook_id')
  if (!playbookId) return errorResponse('playbook_id query parameter required', 400)

  return handleStats(supabase, playbookId, auth.organizationId)
}))

// ── Stats ───────────────────────────────────────────────────

export function buildGroupStats(rows: { account_converted: boolean | null }[]): GroupStats {
  const sampleSize = rows.length
  const resolvedCount = rows.filter((r) => r.account_converted === true).length
  return {
    sample_size: sampleSize,
    resolved_count: resolvedCount,
    resolution_rate: sampleSize === 0 ? null : resolvedCount / sampleSize,
    sample_size_warning: sampleSize < SAMPLE_SIZE_WARNING_THRESHOLD,
  }
}

export async function handleStats(
  supabase: SupabaseClient,
  playbookId: string,
  authOrgId: string,
): Promise<Response> {
  const { data: playbook, error: playbookError } = await supabase
    .from('playbooks')
    .select('id')
    .eq('id', playbookId)
    .eq('organization_id', authOrgId)
    .maybeSingle()

  if (playbookError || !playbook) return errorResponse('Playbook not found', 404)

  const { data: rows, error } = await supabase
    .from('playbook_executions')
    .select('manual_executed_at, account_converted')
    .eq('organization_id', authOrgId)
    .eq('playbook_id', playbookId)

  if (error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-outcome-stats', message: error.message }))
    return errorResponse('Failed to compute stats', 500)
  }

  const allRows = (rows ?? []) as { manual_executed_at: string | null; account_converted: boolean | null }[]
  const executed = allRows.filter((r) => r.manual_executed_at !== null)
  const notExecuted = allRows.filter((r) => r.manual_executed_at === null)

  return jsonResponse({
    playbook_id: playbookId,
    executed: buildGroupStats(executed),
    not_executed: buildGroupStats(notExecuted),
  })
}
