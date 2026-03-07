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
  SEGMENT_FILTERS,
  buildSegmentCsv,
  type SegmentAccountRow,
} from '../_shared/segment-export-helpers.ts'

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

Deno.serve(async (req: Request): Promise<Response> => {
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
      const msg = err.status === 401 ? 'Non authentifié'
        : err.status === 403 ? 'Organisation non configurée'
        : err.message
      return jsonError(msg, err.status)
    }
    return jsonError('Non authentifié', 401)
  }

  const orgId = auth.organizationId

  // 3. VALIDATE segment query param
  const url = new URL(req.url)
  const segmentParam = url.searchParams.get('segment')

  if (!segmentParam || !isValidSegment(segmentParam)) {
    return jsonError(
      `Segment invalide. Valeurs acceptées : ${VALID_SEGMENTS.join(', ')}`,
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
    return jsonError('Erreur serveur lors de l\'export', 500)
  }

  // 5. QUERY accounts (all accounts for org, no LIMIT — export complet)
  const startMs = Date.now()
  const { data: allAccounts, error: dbError } = await supabase
    .from('accounts')
    .select(
      'stripe_customer_id, hubspot_company_id, plan_tier, billing_interval, ' +
      'mrr_cents, seat_count, seat_limit, contract_end_date, ' +
      'health_score, churn_risk_score, expansion_score, product_usage_score, created_at'
    )
    .eq('organization_id', orgId)
    .order('mrr_cents', { ascending: false })

  if (dbError) {
    logger.error('Accounts query failed', { error: dbError.message })
    return jsonError('Erreur serveur lors de l\'export', 500)
  }

  // 6. FILTER in-memory by segment (mirrors frontend segment-queries.ts)
  const filterFn = SEGMENT_FILTERS[segment]
  const rows: SegmentAccountRow[] = (allAccounts ?? [])
    .filter((a: Record<string, unknown>) => {
      const row: SegmentAccountRow = {
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
        created_at: a.created_at as string | null,
      }
      return filterFn(row)
    })
    .map((a: Record<string, unknown>): SegmentAccountRow => ({
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
      created_at: a.created_at as string | null,
    }))

  const durationMs = Date.now() - startMs

  // 7. BUILD CSV (with BOM for Excel FR)
  const csv = buildSegmentCsv(rows)

  logger.info('Segment export completed', {
    organization_id: orgId,
    segment,
    total_accounts: (allAccounts ?? []).length,
    filtered_accounts: rows.length,
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
})
