// ============================================================
// Edge Function : accounts-api
// Gestion des comptes clients : liste, détail avec narratives,
// mise à jour du display_name.
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// GET /accounts-api
//   Query params : limit (1-100, défaut 50), cursor (UUID, pagination)
//                  search (texte libre sur display_name ou stripe_customer_id)
//   Response 200 :
//     {
//       data: Array<Account & { priority_label: 'critical' | 'watch' | 'new' | 'stable' }>,
//       pagination: { limit: number, next_cursor: string | null, has_more: boolean },
//       total_count: number,       // total de comptes de l'org, indépendant de la pagination
//       total_mrr_cents: number    // idem, source : RPC get_portfolio_snapshot (chantier 5.1)
//     }
//   priority_label calculé côté SQL (vue accounts_with_priority) :
//     critical : churn_risk_score >= 80 OU health_score <= 30
//     watch    : churn_risk_score >= 50 OU health_score <= 55
//     new      : created_at < 90j ET churn_risk_score < 50
//     stable   : sinon
//
// GET /accounts-api?id=:uuid
//   Response 200 :
//     {
//       data: {
//         ...account fields,
//         display_name: string | null,
//         scores: {
//           health:     { value: number | null, narrative: string },
//           usage:      { value: number | null, narrative: string },
//           financial:  { value: number | null, narrative: string },
//           engagement: { value: number | null, narrative: string },
//           contract:   { value: number | null, narrative: string },
//           churn_risk: { value: number | null },
//           expansion:  { value: number | null }
//         },
//         insights: Array<Insight & { is_new: boolean }>,
//         segments: Array<{ segment_type: string, priority: string, added_at: string }>,
//         hubspot:  HubspotCompany | null
//       }
//     }
//   Response 404 : { error: "Account not found" }
//
// PATCH /accounts-api?id=:uuid
//   Body : { display_name: string | null }
//   Contrainte : display_name est un alias Sentio, jamais synchronisé
//                depuis Stripe ou HubSpot.
//   Response 200 : { data: { id, display_name } }
//   Response 400 : { error: "..." }
//
// Auth : JWT utilisateur vérifié dans le code (ES256 via verifyUserAuth)
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { generateNarratives } from '../_shared/score-narratives.ts'

// ── Entrypoint ───────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

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
    console.error(JSON.stringify({ level: 'error', function_name: 'accounts-api', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const url = new URL(req.url)
  const orgId = auth.organizationId
  const id = url.searchParams.get('id')

  switch (req.method) {
    case 'GET':
      return id ? handleGetOne(supabase, id, orgId, auth.userId) : handleList(supabase, url, orgId)
    case 'PATCH':
      return id
        ? handlePatch(supabase, id, req, orgId)
        : errorResponse('id query parameter required', 400)
    default:
      return errorResponse('Method not allowed', 405)
  }
})

// ── GET list ─────────────────────────────────────────────────

async function handleList(
  supabase: ReturnType<typeof createServiceClient>,
  url: URL,
  orgId: string,
): Promise<Response> {
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10)))
  const cursor = url.searchParams.get('cursor')
  const search = url.searchParams.get('search')?.trim()

  let query = supabase
    .from('accounts_with_priority')
    .select(
      'id, stripe_customer_id, display_name, plan_tier, billing_interval, mrr_cents, ' +
      'seat_count, seat_limit, ' +
      'health_score, churn_risk_score, expansion_score, product_usage_score, ' +
      'financial_score, engagement_score, contract_score, ' +
      'contract_end_date, scores_calculated_at, created_at, updated_at, priority_label',
    )
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(limit + 1)

  if (cursor) query = query.lt('created_at', cursor)
  if (search) {
    query = query.or(
      `stripe_customer_id.ilike.%${search}%,display_name.ilike.%${search}%`,
    )
  }

  const [{ data, error }, snapshotRes] = await Promise.all([
    query,
    supabase.rpc('get_portfolio_snapshot', { p_organization_id: orgId }).maybeSingle(),
  ])

  if (error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'accounts-api', organization_id: orgId, message: error.message }))
    return errorResponse('Failed to fetch accounts', 500)
  }

  if (snapshotRes.error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'accounts-api', organization_id: orgId, message: snapshotRes.error.message }))
    return errorResponse('Failed to fetch portfolio snapshot', 500)
  }

  const rows = data ?? []
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const nextCursor = hasMore ? items[items.length - 1]?.created_at ?? null : null

  const snapshot = snapshotRes.data as { total_accounts: number; total_mrr_cents: number } | null

  return jsonResponse({
    data: items,
    pagination: { limit, next_cursor: nextCursor, has_more: hasMore },
    total_count: snapshot?.total_accounts ?? 0,
    total_mrr_cents: snapshot?.total_mrr_cents ?? 0,
  })
}

// ── GET one (with narratives + is_new) ───────────────────────

async function handleGetOne(
  supabase: ReturnType<typeof createServiceClient>,
  id: string,
  orgId: string,
  userId: string,
): Promise<Response> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  const [
    accountRes,
    invoicesRes,
    usageRes,
    hubspotRes,
    insightsRes,
    segmentsRes,
    profileRes,
  ] = await Promise.all([
    supabase.from('accounts').select('*').eq('id', id).eq('organization_id', orgId).maybeSingle(),
    supabase.from('invoices').select('status, amount_cents')
      .eq('account_id', id).in('status', ['open', 'uncollectible']).limit(200),
    supabase.from('usage_events').select('event_count')
      .eq('account_id', id).gte('event_date', thirtyDaysAgo).limit(1000),
    supabase.from('hubspot_companies').select('*')
      .eq('account_id', id).eq('organization_id', orgId).maybeSingle(),
    supabase.from('ai_insights').select('*')
      .eq('account_id', id).eq('organization_id', orgId).eq('status', 'active')
      .order('priority', { ascending: true }).limit(10),
    supabase.from('segment_memberships')
      .select('status, added_at, risk_score, account_segments(segment_type, priority)')
      .eq('account_id', id).eq('organization_id', orgId).eq('status', 'active').limit(5),
    supabase.from('profiles_').select('last_seen_at').eq('auth_user_id', userId).maybeSingle(),
  ])

  if (accountRes.error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'accounts-api', message: accountRes.error.message }))
    return errorResponse('Failed to fetch account', 500)
  }
  if (!accountRes.data) return errorResponse('Account not found', 404)

  const account = accountRes.data
  const overdueInvoices = invoicesRes.data ?? []
  const overdueCount = overdueInvoices.length
  const overdueAmountCents = overdueInvoices.reduce((sum: number, inv: { amount_cents: number }) => sum + (inv.amount_cents ?? 0), 0)
  const totalEvents30d = (usageRes.data ?? []).reduce((sum: number, ev: { event_count: number }) => sum + (ev.event_count ?? 0), 0)
  const hubspot = hubspotRes.data ?? null
  const lastSeenAt: string | null = profileRes.data?.last_seen_at ?? null

  const insights = (insightsRes.data ?? []).map((ins: Record<string, unknown>) => ({
    ...ins,
    is_new: lastSeenAt ? new Date(ins.created_at as string) > new Date(lastSeenAt) : false,
  }))

  const segments = (segmentsRes.data ?? []).map((sm: Record<string, unknown>) => {
    const seg = sm.account_segments as Record<string, unknown> | null
    return {
      segment_type: seg?.segment_type ?? null,
      priority: seg?.priority ?? null,
      added_at: sm.added_at,
      risk_score: sm.risk_score,
    }
  })

  const narratives = generateNarratives({
    health_score: account.health_score,
    financial_score: account.financial_score,
    product_usage_score: account.product_usage_score,
    engagement_score: account.engagement_score,
    contract_score: account.contract_score,
    mrr_cents: account.mrr_cents ?? 0,
    contract_start_date: account.contract_start_date ?? null,
    contract_end_date: account.contract_end_date ?? null,
    billing_interval: account.billing_interval ?? null,
    overdue_count: overdueCount,
    overdue_amount_cents: overdueAmountCents,
    total_events_30d: totalEvents30d,
    open_ticket_count: hubspot?.open_ticket_count ?? null,
    last_meeting_date: hubspot?.last_meeting_date ?? null,
  })

  const scores = {
    health:     { value: account.health_score,          narrative: narratives.health_narrative },
    usage:      { value: account.product_usage_score,   narrative: narratives.usage_narrative },
    financial:  { value: account.financial_score,       narrative: narratives.financial_narrative },
    engagement: { value: account.engagement_score,      narrative: narratives.engagement_narrative },
    contract:   { value: account.contract_score,        narrative: narratives.contract_narrative },
    churn_risk: { value: account.churn_risk_score },
    expansion:  { value: account.expansion_score },
  }

  return jsonResponse({
    data: {
      id: account.id,
      organization_id: account.organization_id,
      stripe_customer_id: account.stripe_customer_id,
      hubspot_company_id: account.hubspot_company_id,
      display_name: account.display_name,
      plan_tier: account.plan_tier,
      billing_interval: account.billing_interval,
      mrr_cents: account.mrr_cents,
      arr_cents: account.arr_cents,
      seat_count: account.seat_count,
      seat_limit: account.seat_limit,
      contract_start_date: account.contract_start_date,
      contract_end_date: account.contract_end_date,
      scores_calculated_at: account.scores_calculated_at,
      created_at: account.created_at,
      updated_at: account.updated_at,
      scores,
      insights,
      segments,
      hubspot,
    },
  })
}

// ── PATCH display_name ───────────────────────────────────────

async function handlePatch(
  supabase: ReturnType<typeof createServiceClient>,
  id: string,
  req: Request,
  orgId: string,
): Promise<Response> {
  let body: { display_name?: string | null }
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!('display_name' in body)) {
    return errorResponse('display_name field is required', 400)
  }

  const displayName = body.display_name

  // Validation : null ou string non vide, max 200 chars
  if (displayName !== null) {
    if (typeof displayName !== 'string' || displayName.trim().length === 0) {
      return errorResponse('display_name must be a non-empty string or null', 400)
    }
    if (displayName.length > 200) {
      return errorResponse('display_name must not exceed 200 characters', 400)
    }
  }

  const { data, error } = await supabase
    .from('accounts')
    .update({ display_name: displayName ?? null })
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('id, display_name')
    .maybeSingle()

  if (error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'accounts-api', organization_id: orgId, message: error.message }))
    return errorResponse('Failed to update display_name', 500)
  }

  if (!data) return errorResponse('Account not found', 404)

  return jsonResponse({ data })
}
