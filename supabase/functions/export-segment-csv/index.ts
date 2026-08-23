// ============================================================
// Edge Function: export-segment-csv
// Exporte les comptes d'un segment en CSV.
// ============================================================
//
// GET /functions/v1/export-segment-csv?segment=champions
// Headers: Authorization: Bearer <supabase_jwt>
//
// Reponse CSV : Content-Type: text/csv; charset=utf-8
//              Content-Disposition: attachment; filename="segment-<SEGMENT>.csv"
//
// Erreurs :
//   400 Bad Request  — segment manquant ou invalide
//   401 Unauthorized — token manquant ou invalide
//   403 Forbidden    — pas d'organization_id
//   500 Internal     — erreur serveur

import { handleCors, corsHeaders } from '../_shared/cors.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { createServiceClient } from '../_shared/supabase-client.ts'
import { createLogger } from '../_shared/structured-logger.ts'
import { isValidSegment, VALID_SEGMENTS } from '../_shared/validators.ts'
import {
  buildSegmentCsv,
  type SegmentAccountRow,
} from '../_shared/segment-export-helpers.ts'
import { withSentry } from '../_shared/sentry.ts'

// ── Error response helper (includes CORS) ──

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

// ============================================================
// Main handler
// ============================================================

Deno.serve(withSentry('export-segment-csv', async (req: Request): Promise<Response> => {
  // 1. CORS preflight
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  // Only GET allowed
  if (req.method !== 'GET') {
    return jsonError('Method not allowed', 405)
  }

  const correlationId = crypto.randomUUID()
  const logger = createLogger({
    correlation_id: correlationId,
    function_name: 'export-segment-csv',
  })

  // 2. AUTH — JWT verification
  let auth
  try {
    auth = await verifyUserAuth(req)
  } catch (err) {
    if (err instanceof AuthError) {
      const msg = err.status === 401 ? 'Not authenticated'
        : err.status === 403 ? 'Organization not configured'
        : err.message
      return jsonError(msg, err.status)
    }
    return jsonError('Not authenticated', 401)
  }

  const orgId = auth.organizationId

  // 3. VALIDATE segment query param
  const url = new URL(req.url)
  const segmentParam = url.searchParams.get('segment')

  if (!segmentParam || !isValidSegment(segmentParam)) {
    return jsonError(
      `Invalid segment. Accepted values: ${VALID_SEGMENTS.join(', ')}`,
      400,
    )
  }

  const segment = segmentParam
  logger.info('Segment export request', { organization_id: orgId, segment })

  // 4. SERVICE CLIENT
  let supabase
  try {
    supabase = createServiceClient()
  } catch {
    logger.error('Service client creation failed')
    return jsonError('Server error during export', 500)
  }

  const startMs = Date.now()

  // 5. RESOLVE segment membership — reads the already-computed segment
  // (account_segments/segment_memberships), the same source of truth every
  // other segment view in the product reads from. Replaces a local
  // re-derivation of segment rules from raw scores (SEGMENT_FILTERS,
  // removed 2026-08-23) that had regressed on decision C2.5 (an empty
  // eligibility_criteria group is supposed to match nothing, not
  // everything) and had silently drifted off the V3 scoring engine — see
  // PARKING_LOT.md. Joined manually (not via the get_segment_accounts RPC)
  // because that RPC resolves the org via user_organization_id(), which
  // only works against the caller's own JWT context — this function runs
  // as service_role and already resolves organization_id itself via
  // verifyUserAuth(), the same explicit-org-scoping pattern used
  // everywhere else in this file.
  const { data: segmentRow, error: segmentError } = await supabase
    .from('account_segments')
    .select('id')
    .eq('organization_id', orgId)
    .eq('segment_type', segment)
    .eq('is_active', true)
    .maybeSingle()

  if (segmentError) {
    logger.error('Segment lookup failed', { error: segmentError.message })
    return jsonError('Server error during export', 500)
  }

  let accountIds: string[] = []
  if (segmentRow) {
    const { data: memberships, error: membershipError } = await supabase
      .from('segment_memberships')
      .select('account_id')
      .eq('organization_id', orgId)
      .eq('segment_id', segmentRow.id)
      .eq('status', 'active')

    if (membershipError) {
      logger.error('Segment membership query failed', { error: membershipError.message })
      return jsonError('Server error during export', 500)
    }
    accountIds = (memberships ?? []).map((m: { account_id: string }) => m.account_id)
  }

  // 6. QUERY the accounts belonging to that segment (no LIMIT — export complet)
  const { data: segmentAccounts, error: dbError } = accountIds.length === 0
    ? { data: [] as Record<string, unknown>[], error: null }
    : await supabase
        .from('accounts')
        .select(
          'stripe_customer_id, hubspot_company_id, plan_tier, billing_interval, ' +
          'mrr_cents, seat_count, seat_limit, contract_end_date, ' +
          'health_score, churn_risk_score, expansion_score, product_usage_score'
        )
        .eq('organization_id', orgId)
        .in('id', accountIds)
        .order('mrr_cents', { ascending: false })

  if (dbError) {
    logger.error('Accounts query failed', { error: dbError.message })
    return jsonError('Server error during export', 500)
  }

  const rows: SegmentAccountRow[] = (segmentAccounts ?? []).map((a: Record<string, unknown>): SegmentAccountRow => ({
    stripe_customer_id: a.stripe_customer_id as string | null,
    hubspot_company_id: a.hubspot_company_id as string | null,
    plan_tier: a.plan_tier as string | null,
    billing_interval: a.billing_interval as string | null,
    mrr_cents: a.mrr_cents as number | null,
    seat_count: a.seat_count as number | null,
    seat_limit: a.seat_limit as number | null,
    contract_end_date: a.contract_end_date as string | null,
    health_score: a.health_score as number | null,
    churn_risk_score: a.churn_risk_score as number | null,
    expansion_score: a.expansion_score as number | null,
    product_usage_score: a.product_usage_score as number | null,
  }))

  const durationMs = Date.now() - startMs

  // 7. BUILD CSV (with BOM for Excel compatibility)
  const csv = buildSegmentCsv(rows)

  logger.info('Segment export completed', {
    organization_id: orgId,
    segment,
    segment_accounts_found: rows.length,
    duration_ms: durationMs,
  })

  // 8. RESPONSE
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="segment-${segment}.csv"`,
      'Cache-Control': 'no-store',
      ...corsHeaders,
    },
  })
}))
