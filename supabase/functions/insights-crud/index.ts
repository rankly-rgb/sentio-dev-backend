// ============================================================
// Edge Function : insights-crud
// API REST pour la consultation et gestion des insights IA
//
// Routes :
//   GET  ?page=N&per_page=M          — Liste dédupliquée, triée priority/mrr/created_at DESC
//   GET  ?id=X                       — Détail d'un insight
//   GET  ?stats=true&organization_id=X — Compteurs agrégés
//   PATCH ?id=X                      — Transition de statut
//
// Auth : JWT vérifié dans le code (ES256 via verifyUserAuth)
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'

// ── Valid values ─────────────────────────────────────────────
const VALID_INSIGHT_TYPES = ['churn_prediction', 'expansion_opportunity', 'renewal_alert', 'payment_risk', 'usage_drop', 'account_health_summary'] as const
const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const
const VALID_STATUSES = ['active', 'acknowledged', 'resolved', 'dismissed'] as const

// ── Status transition rules ─────────────────────────────────
const VALID_TRANSITIONS: Record<string, string[]> = {
  active: ['acknowledged', 'resolved', 'dismissed'],
  acknowledged: ['resolved', 'dismissed'],
  resolved: [],
  dismissed: [],
}

// ── Query parsing (pure, exported for tests) ─────────────────

export function parsePage(raw: string | null): number {
  const n = parseInt(raw ?? '1', 10)
  if (!Number.isFinite(n) || n < 1) return 1
  return n
}

export function parsePerPage(raw: string | null): number {
  const n = parseInt(raw ?? '20', 10)
  if (!Number.isFinite(n) || n < 1) return 20
  return Math.min(100, n)
}

export function parseCsvFilter<T extends string>(raw: string | null, valid: readonly T[]): T[] | null {
  if (!raw) return null
  const values = raw.split(',').filter((v): v is T => (valid as readonly string[]).includes(v))
  return values.length > 0 ? values : null
}

// ── Entrypoint ───────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  // Auth
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
    console.error(JSON.stringify({ level: 'error', function_name: 'insights-crud', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const url = new URL(req.url)
  const orgId = auth.organizationId
  const id = url.searchParams.get('id')
  const stats = url.searchParams.get('stats')

  switch (req.method) {
    case 'GET':
      if (id) return handleGetOne(supabase, id, orgId)
      if (stats === 'true') return handleStats(supabase, orgId)
      return handleList(supabase, url, orgId)
    case 'PATCH':
      return id ? handlePatch(supabase, id, req, orgId, auth.userId) : errorResponse('id query parameter required', 400)
    default:
      return errorResponse('Method not allowed', 405)
  }
})

// ── GET list ─────────────────────────────────────────────────
//
// Sort is fixed server-side: priority DESC (critical first), mrr_impact DESC,
// created_at DESC — required for the dedup RPC's DISTINCT ON to be
// deterministic. `sort` is accepted (frontend always sends it) but has no
// effect; it exists only so an unrecognized query param doesn't need special
// handling on either side.
// Dedup: at most 1 row per (account_id, insight_type, created_at UTC day) — see
// list_deduplicated_insights / count_deduplicated_insights (migration 20260705000001).

async function handleList(supabase: SupabaseClient, url: URL, orgId: string): Promise<Response> {
  const page = parsePage(url.searchParams.get('page'))
  const perPage = parsePerPage(url.searchParams.get('per_page'))
  const limit = perPage
  const offset = (page - 1) * perPage

  const insightType = parseCsvFilter(url.searchParams.get('insight_type'), VALID_INSIGHT_TYPES)
  const priority = parseCsvFilter(url.searchParams.get('priority'), VALID_PRIORITIES)
  const status = parseCsvFilter(url.searchParams.get('status'), VALID_STATUSES) ?? ['active']
  const accountId = url.searchParams.get('account_id')

  const [listResult, countResult, criticalResult] = await Promise.all([
    supabase.rpc('list_deduplicated_insights', {
      p_organization_id: orgId,
      p_status: status,
      p_insight_type: insightType,
      p_priority: priority,
      p_account_id: accountId,
      p_limit: limit,
      p_offset: offset,
    }),
    supabase.rpc('count_deduplicated_insights', {
      p_organization_id: orgId,
      p_status: status,
      p_insight_type: insightType,
      p_priority: priority,
      p_account_id: accountId,
    }),
    // critical_count feeds the nav badge: always active + critical, ignores current filters
    supabase.rpc('count_deduplicated_insights', {
      p_organization_id: orgId,
      p_status: ['active'],
      p_insight_type: null,
      p_priority: ['critical'],
      p_account_id: null,
    }),
  ])

  if (listResult.error || countResult.error || criticalResult.error) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'insights-crud',
      organization_id: orgId,
      message: `list query failed: ${listResult.error?.message ?? countResult.error?.message ?? criticalResult.error?.message}`,
    }))
    return errorResponse('Failed to fetch insights', 500)
  }

  return jsonResponse({
    data: listResult.data ?? [],
    pagination: {
      page,
      per_page: perPage,
      total_count: countResult.data ?? 0,
    },
    critical_count: criticalResult.data ?? 0,
  })
}

// ── GET one ──────────────────────────────────────────────────

async function handleGetOne(supabase: SupabaseClient, id: string, orgId: string): Promise<Response> {
  const { data, error } = await supabase
    .from('ai_insights')
    .select('*')
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle()

  if (error) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'insights-crud',
      organization_id: orgId,
      message: `get one query failed: ${error.message}`,
    }))
    return errorResponse('Failed to fetch insight', 500)
  }

  if (!data) {
    return errorResponse('Insight not found', 404)
  }

  return jsonResponse({ data })
}

// ── GET stats ────────────────────────────────────────────────

async function handleStats(supabase: SupabaseClient, orgId: string): Promise<Response> {
  // Fetch all active + acknowledged insights for stats
  const { data, error } = await supabase
    .from('ai_insights')
    .select('insight_type, priority, status, mrr_impact_cents')
    .eq('organization_id', orgId)
    .in('status', ['active', 'acknowledged'])
    .limit(10000)

  if (error) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'insights-crud',
      organization_id: orgId,
      message: `stats query failed: ${error.message}`,
    }))
    return errorResponse('Failed to fetch stats', 500)
  }

  const rows = data ?? []

  // Build stats
  const byType: Record<string, number> = {}
  const byPriority: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  let totalMrrImpact = 0

  for (const row of rows) {
    byType[row.insight_type] = (byType[row.insight_type] ?? 0) + 1
    byPriority[row.priority] = (byPriority[row.priority] ?? 0) + 1
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
    totalMrrImpact += row.mrr_impact_cents ?? 0
  }

  return jsonResponse({
    data: {
      total: rows.length,
      total_mrr_impact_cents: totalMrrImpact,
      by_type: byType,
      by_priority: byPriority,
      by_status: byStatus,
    },
  })
}

// ── PATCH (status transition) ────────────────────────────────

async function handlePatch(
  supabase: SupabaseClient,
  id: string,
  req: Request,
  orgId: string,
  userId: string,
): Promise<Response> {
  let body: { status?: string }
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!body.status) {
    return errorResponse('status field is required', 400)
  }

  if (!VALID_STATUSES.includes(body.status as typeof VALID_STATUSES[number])) {
    return errorResponse(`Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`, 400)
  }

  // Fetch current insight
  const { data: current, error: fetchError } = await supabase
    .from('ai_insights')
    .select('id, status')
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle()

  if (fetchError) {
    return errorResponse('Failed to fetch insight', 500)
  }

  if (!current) {
    return errorResponse('Insight not found', 404)
  }

  // Validate transition
  const allowedTransitions = VALID_TRANSITIONS[current.status] ?? []
  if (!allowedTransitions.includes(body.status)) {
    return errorResponse(
      `Cannot transition from '${current.status}' to '${body.status}'. Allowed: ${allowedTransitions.join(', ') || 'none'}`,
      422,
    )
  }

  // Build update
  const now = new Date().toISOString()
  const updates: Record<string, unknown> = { status: body.status }

  switch (body.status) {
    case 'acknowledged':
      updates.acknowledged_at = now
      updates.acknowledged_by = userId
      break
    case 'resolved':
      updates.resolved_at = now
      break
    case 'dismissed':
      updates.dismissed_at = now
      break
  }

  const { data: updated, error: updateError } = await supabase
    .from('ai_insights')
    .update(updates)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select()
    .maybeSingle()

  if (updateError) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'insights-crud',
      organization_id: orgId,
      message: `update failed: ${updateError.message}`,
    }))
    return errorResponse('Failed to update insight', 500)
  }

  return jsonResponse({ data: updated })
}
