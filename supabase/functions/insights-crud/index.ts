// ============================================================
// Edge Function : insights-crud
// API REST pour la consultation et gestion des insights IA
//
// Routes :
//   GET  ?organization_id=X          — Liste paginée (filtres)
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
const VALID_SORT_FIELDS = ['created_at', 'priority', 'confidence_score', 'mrr_impact_cents'] as const

// Priority ordering for sort
const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

// ── Status transition rules ─────────────────────────────────
const VALID_TRANSITIONS: Record<string, string[]> = {
  active: ['acknowledged', 'resolved', 'dismissed'],
  acknowledged: ['resolved', 'dismissed'],
  resolved: [],
  dismissed: [],
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

async function handleList(supabase: SupabaseClient, url: URL, orgId: string): Promise<Response> {
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10))
  const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') ?? '20', 10)))
  const offset = (page - 1) * perPage

  // Filters
  const insightType = url.searchParams.get('insight_type')
  const priority = url.searchParams.get('priority')
  const status = url.searchParams.get('status') ?? 'active'
  const accountId = url.searchParams.get('account_id')
  const sort = url.searchParams.get('sort') ?? 'created_at'

  // Build query
  let query = supabase
    .from('ai_insights')
    .select('*', { count: 'exact' })
    .eq('organization_id', orgId)

  // Apply filters
  if (status) {
    const statuses = status.split(',').filter((s) => VALID_STATUSES.includes(s as typeof VALID_STATUSES[number]))
    if (statuses.length === 1) {
      query = query.eq('status', statuses[0])
    } else if (statuses.length > 1) {
      query = query.in('status', statuses)
    }
  }

  if (insightType) {
    const types = insightType.split(',').filter((t) => VALID_INSIGHT_TYPES.includes(t as typeof VALID_INSIGHT_TYPES[number]))
    if (types.length === 1) {
      query = query.eq('insight_type', types[0])
    } else if (types.length > 1) {
      query = query.in('insight_type', types)
    }
  }

  if (priority) {
    const priorities = priority.split(',').filter((p) => VALID_PRIORITIES.includes(p as typeof VALID_PRIORITIES[number]))
    if (priorities.length === 1) {
      query = query.eq('priority', priorities[0])
    } else if (priorities.length > 1) {
      query = query.in('priority', priorities)
    }
  }

  if (accountId) {
    query = query.eq('account_id', accountId)
  }

  // Sort
  if (sort === 'priority') {
    // Priority sort: critical > high > medium > low, then by created_at desc
    query = query.order('priority', { ascending: true }).order('created_at', { ascending: false })
  } else if (sort === 'confidence_score') {
    query = query.order('confidence_score', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })
  } else if (sort === 'mrr_impact_cents') {
    query = query.order('mrr_impact_cents', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })
  } else {
    query = query.order('created_at', { ascending: false })
  }

  // Pagination
  query = query.range(offset, offset + perPage - 1)

  const { data, error, count } = await query

  if (error) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'insights-crud',
      organization_id: orgId,
      message: `list query failed: ${error.message}`,
    }))
    return errorResponse('Failed to fetch insights', 500)
  }

  return jsonResponse({
    data: data ?? [],
    pagination: {
      page,
      per_page: perPage,
      total: count ?? 0,
      total_pages: Math.ceil((count ?? 0) / perPage),
    },
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
