// ============================================================
// Edge Function : get-sync-status
// GET /get-sync-status
//
// Retourne le statut du sync initial Stripe pour le polling
// frontend pendant l'onboarding.
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
// GET /get-sync-status
//   Auth : Bearer token (JWT ES256)
//   Response 200 :
//     {
//       status: "pending" | "running" | "completed" | "error",
//       steps: { behavioral: boolean, cohorts: boolean, scores: boolean },
//       error_message: string | null
//     }
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, jsonResponse, errorResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'

export type SyncStatus = 'pending' | 'running' | 'completed' | 'error'

export interface SyncSteps {
  behavioral: boolean
  cohorts: boolean
  scores: boolean
}

export function deriveSyncStatus(sync: {
  sync_status: string
  started_at: string | null
  completed_at: string | null
  error_message: string | null
} | null): SyncStatus {
  if (!sync) return 'pending'
  if (sync.error_message) return 'error'
  if (sync.completed_at) return 'completed'
  if (sync.started_at) return 'running'
  return 'pending'
}

Deno.serve(async (req: Request): Promise<Response> => {
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
    console.error(JSON.stringify({ level: 'error', function_name: 'get-sync-status', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const orgId = auth.organizationId

  const [syncRes, accountsRes, scoresRes] = await Promise.all([
    supabase
      .from('data_syncs')
      .select('sync_status, started_at, completed_at, error_message')
      .eq('organization_id', orgId)
      .eq('sync_source', 'stripe')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('accounts')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('is_demo', false),
    supabase
      .from('score_history')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .limit(1),
  ])

  const sync = syncRes.data ?? null
  const status = deriveSyncStatus(sync)

  const accountsCount = accountsRes.count ?? 0
  const scoresCount = scoresRes.count ?? 0

  const steps: SyncSteps = {
    behavioral: status === 'completed' || status === 'running',
    cohorts: accountsCount > 0,
    scores: scoresCount > 0,
  }

  return jsonResponse({
    status,
    steps,
    error_message: sync?.error_message ?? null,
  })
})
