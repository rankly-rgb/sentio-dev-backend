// ============================================================
// Edge Function: export-segment-csv
// Exporte les comptes d'un segment en CSV.
// ============================================================
//
// GET /functions/v1/export-segment-csv?segment=champions&sort_by=mrr_cents&sort_order=desc
// Headers: Authorization: Bearer <supabase_jwt>
//
// Reponse CSV : Content-Type: text/csv
//              Content-Disposition: attachment; filename="sentio_segment_<SEGMENT>_<DATE>.csv"
//
// Erreurs :
//   400 Bad Request  — segment manquant ou invalide
//   401 Unauthorized — token manquant ou invalide
//   500 Internal     — erreur serveur

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors, corsHeaders } from '../_shared/cors.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { createServiceClient, errorResponse } from '../_shared/supabase-client.ts'
import { createLogger } from '../_shared/structured-logger.ts'
import { recordMetric } from '../_shared/metrics.ts'
import {
  VALID_SEGMENTS,
  isValidSegment,
  isValidSortField,
  isValidSortOrder,
  type SegmentKey,
  type SortField,
  type SortOrder,
} from '../_shared/validators.ts'
import {
  buildSegmentCsv,
  type SegmentAccountRow,
} from '../_shared/segment-export-helpers.ts'

// ============================================================
// Main handler
// ============================================================

Deno.serve(async (req: Request): Promise<Response> => {
  // 1. CORS
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  // Only GET allowed
  if (req.method !== 'GET') {
    return errorResponse('Method not allowed', 405)
  }

  const correlationId = crypto.randomUUID()
  const logger = createLogger({
    correlation_id: correlationId,
    function_name: 'export-segment-csv',
  })

  // 2. AUTH
  let auth
  try {
    auth = await verifyUserAuth(req)
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.message, err.status)
    return errorResponse('Authentication failed', 401)
  }

  const orgId = auth.organizationId

  // 3. PARSE & VALIDATE QUERY PARAMS
  const url = new URL(req.url)
  const segmentParam = url.searchParams.get('segment')

  if (!segmentParam) {
    return errorResponse('segment query parameter is required', 400)
  }
  if (!isValidSegment(segmentParam)) {
    return errorResponse(
      `Invalid segment "${segmentParam}". Valid segments: ${VALID_SEGMENTS.join(', ')}`,
      400
    )
  }

  const segment: SegmentKey = segmentParam
  const sortBy: SortField = isValidSortField(url.searchParams.get('sort_by') ?? '')
    ? (url.searchParams.get('sort_by') as SortField)
    : 'mrr_cents'
  const sortOrder: SortOrder = isValidSortOrder(url.searchParams.get('sort_order') ?? '')
    ? (url.searchParams.get('sort_order') as SortOrder)
    : 'desc'

  logger.info('Segment export request', { organization_id: orgId, segment, sortBy, sortOrder })

  // 4. SERVICE CLIENT
  let supabase: SupabaseClient
  try {
    supabase = createServiceClient()
  } catch {
    logger.error('Service client creation failed')
    return errorResponse('Server configuration error', 500)
  }

  // 5. CALL RPC get_segment_accounts
  const startMs = Date.now()
  const { data: rows, error: rpcError } = await supabase.rpc('get_segment_accounts', {
    p_segment: segment,
    p_sort_by: sortBy,
    p_sort_order: sortOrder,
    p_limit: 10000,
    p_offset: 0,
  })

  if (rpcError) {
    logger.error('RPC get_segment_accounts failed', { error: rpcError.message })
    return errorResponse('Server error', 500)
  }

  const accounts: SegmentAccountRow[] = (rows ?? []).map((r: Record<string, unknown>) => ({
    stripe_customer_id: r.stripe_customer_id as string | null,
    hubspot_company_id: r.hubspot_company_id as string | null,
    plan_tier: r.plan_tier as string | null,
    billing_interval: r.billing_interval as string | null,
    mrr_cents: r.mrr_cents as number | null,
    seat_count: r.seat_count as number | null,
    seat_limit: r.seat_limit as number | null,
    contract_end_date: r.contract_end_date as string | null,
    health_score: r.health_score as number | null,
    churn_risk_score: r.churn_risk_score as number | null,
    expansion_score: r.expansion_score as number | null,
    product_usage_score: r.product_usage_score as number | null,
  }))

  const durationMs = Date.now() - startMs

  // 6. BUILD CSV
  const csv = buildSegmentCsv(accounts)

  // 7. LOG METRIC (fire-and-forget)
  recordMetric(supabase, {
    organization_id: orgId,
    provider: 'usage',
    sync_type: 'segment_export',
    duration_ms: durationMs,
    records_processed: accounts.length,
    success: true,
  }).catch(() => {})

  logger.info('Segment export completed', {
    organization_id: orgId,
    segment,
    row_count: accounts.length,
    duration_ms: durationMs,
  })

  // 8. RESPONSE
  const date = new Date().toISOString().slice(0, 10)
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="sentio_segment_${segment}_${date}.csv"`,
      ...corsHeaders,
    },
  })
})
