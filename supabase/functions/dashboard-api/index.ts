// ============================================================
// Edge Function : dashboard-api
// Données agrégées pour la page "Aujourd'hui" : briefing matinal
// et wins de la semaine.
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// GET /dashboard-api/briefing
//   Response 200 :
//     {
//       data: {
//         portfolio: {
//           current_avg_health: number | null,   // moyenne health score aujourd'hui
//           week_ago_avg_health: number | null,   // moyenne health score J-7
//           health_delta_7d: number | null,       // delta en points (positif = amélioration)
//           health_trend: "up" | "down" | "stable" | "unknown"
//         },
//         risk_accounts_7d: number,    // nb comptes entrés dans un segment risqué en 7j
//         p0_insights_count: number,   // insights actifs priorité "critical"
//         insight_du_jour: {           // compte ayant bougé le plus significativement en 24h
//           account_id: string,
//           stripe_customer_id: string,
//           display_name: string | null,
//           health_score_now: number,
//           health_score_yesterday: number,
//           delta: number,             // positif = amélioration
//           direction: "improved" | "degraded",
//           main_dimension: "usage" | "financial" | "engagement" | "contract"
//         } | null
//       }
//     }
//
// GET /dashboard-api/wins
//   Seuil "win" : amélioration du health_score >= 10 points sur 7 jours,
//   avec health_score actuel >= 50. Les 5 meilleurs wins sont retournés
//   par ordre décroissant de progression.
//
//   Response 200 :
//     {
//       data: Array<{
//         account_id: string,
//         stripe_customer_id: string,
//         display_name: string | null,
//         health_score_now: number,
//         health_score_7d_ago: number,
//         health_delta: number,
//         main_dimension: "usage" | "financial" | "engagement" | "contract",
//         segment_before: string | null,
//         segment_now: string | null,
//         segment_changed: boolean
//       }>
//     }
//
// Auth : JWT utilisateur vérifié dans le code (ES256 via verifyUserAuth)
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'

// Seuil minimum pour qualifier un "win" (en points de health_score)
const WIN_THRESHOLD = 10
// Score minimum pour qu'un compte soit considéré "sain" après le win
const WIN_MIN_HEALTH = 50
// Nb max de wins retournés
const MAX_WINS = 5
// Segments considérés "à risque"
const RISK_SEGMENT_TYPES = ['en_danger_critique', 'a_risque_leger', 'en_churn', 'impayes']

type Dimension = 'usage' | 'financial' | 'engagement' | 'contract'

function dominantDimension(
  now: Record<string, number | null>,
  before: Record<string, number | null>,
): Dimension {
  const deltas: Array<[Dimension, number]> = [
    ['usage', Math.abs((now.product_usage_score ?? 50) - (before.product_usage_score ?? 50))],
    ['financial', Math.abs((now.financial_score ?? 0) - (before.financial_score ?? 0))],
    ['engagement', Math.abs((now.engagement_score ?? 50) - (before.engagement_score ?? 50))],
    ['contract', Math.abs((now.contract_score ?? 50) - (before.contract_score ?? 50))],
  ]
  deltas.sort(([, a], [, b]) => b - a)
  return deltas[0][0]
}

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
    console.error(JSON.stringify({ level: 'error', function_name: 'dashboard-api', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const url = new URL(req.url)
  const orgId = auth.organizationId
  const path = url.pathname.split('/').pop()

  if (req.method !== 'GET') return errorResponse('Method not allowed', 405)

  if (path === 'briefing') return handleBriefing(supabase, orgId)
  if (path === 'wins') return handleWins(supabase, orgId)

  return errorResponse('Not found. Use /dashboard-api/briefing or /dashboard-api/wins', 404)
})

// ── GET /dashboard-api/briefing ──────────────────────────────

async function handleBriefing(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
): Promise<Response> {
  const today = new Date().toISOString().split('T')[0]
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  // Lancer toutes les requêtes en parallèle
  const [
    currentAccountsRes,
    weekAgoScoresRes,
    yesterdayScoresRes,
    riskSegmentsRes,
    p0InsightsRes,
  ] = await Promise.all([
    // Scores actuels (source de vérité : table accounts)
    supabase.from('accounts')
      .select('id, stripe_customer_id, display_name, health_score, product_usage_score, financial_score, engagement_score, contract_score')
      .eq('organization_id', orgId)
      .not('health_score', 'is', null)
      .limit(2000),

    // Scores J-7 depuis score_history
    supabase.from('score_history')
      .select('account_id, health_score, product_usage_score, financial_score, engagement_score, contract_score')
      .eq('organization_id', orgId)
      .eq('snapshot_date', sevenDaysAgo)
      .limit(2000),

    // Scores J-1 pour insight du jour
    supabase.from('score_history')
      .select('account_id, health_score, product_usage_score, financial_score, engagement_score, contract_score')
      .eq('organization_id', orgId)
      .eq('snapshot_date', yesterday)
      .limit(2000),

    // Segments à risque de l'org (pour compter nouveaux entrants J-7)
    supabase.from('account_segments')
      .select('id')
      .eq('organization_id', orgId)
      .in('segment_type', RISK_SEGMENT_TYPES),

    // Insights P0 (critical actifs)
    supabase.from('ai_insights')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .eq('priority', 'critical'),
  ])

  // ── Portfolio health delta ────────────────────────────────
  const currentAccounts = currentAccountsRes.data ?? []
  const weekAgoByAccount = new Map(
    (weekAgoScoresRes.data ?? []).map((s: { account_id: string; health_score: number | null }) => [s.account_id, s]),
  )

  let currentAvgHealth: number | null = null
  let weekAgoAvgHealth: number | null = null

  if (currentAccounts.length > 0) {
    const totalCurrent = currentAccounts.reduce((sum: number, a: { health_score: number | null }) => sum + (a.health_score ?? 0), 0)
    currentAvgHealth = Math.round((totalCurrent / currentAccounts.length) * 10) / 10
  }

  const weekAgoScores = weekAgoScoresRes.data ?? []
  if (weekAgoScores.length > 0) {
    const totalWeekAgo = weekAgoScores.reduce((sum: number, s: { health_score: number | null }) => sum + (s.health_score ?? 0), 0)
    weekAgoAvgHealth = Math.round((totalWeekAgo / weekAgoScores.length) * 10) / 10
  }

  let healthDelta7d: number | null = null
  let healthTrend: 'up' | 'down' | 'stable' | 'unknown' = 'unknown'

  if (currentAvgHealth !== null && weekAgoAvgHealth !== null) {
    healthDelta7d = Math.round((currentAvgHealth - weekAgoAvgHealth) * 10) / 10
    if (healthDelta7d > 1) healthTrend = 'up'
    else if (healthDelta7d < -1) healthTrend = 'down'
    else healthTrend = 'stable'
  }

  // ── Nouveaux entrants en segments à risque (7 jours) ─────
  const riskSegmentIds = (riskSegmentsRes.data ?? []).map((s: { id: string }) => s.id)
  let riskAccounts7d = 0

  if (riskSegmentIds.length > 0) {
    const { count } = await supabase
      .from('segment_memberships')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .in('segment_id', riskSegmentIds)
      .eq('status', 'active')
      .gte('added_at', sevenDaysAgo)
    riskAccounts7d = count ?? 0
  }

  // ── Insight du jour : plus grande variation en 24h ───────
  const yesterdayByAccount = new Map(
    (yesterdayScoresRes.data ?? []).map((s: { account_id: string }) => [s.account_id, s]),
  )

  let insightDuJour = null
  let maxDelta = 0

  for (const account of currentAccounts) {
    const yesterday = yesterdayByAccount.get(account.id)
    if (!yesterday || account.health_score === null || yesterday.health_score === null) continue

    const delta = (account.health_score as number) - (yesterday.health_score as number)
    if (Math.abs(delta) > Math.abs(maxDelta)) {
      maxDelta = delta
      insightDuJour = {
        account_id: account.id,
        stripe_customer_id: account.stripe_customer_id,
        display_name: account.display_name ?? null,
        health_score_now: account.health_score,
        health_score_yesterday: yesterday.health_score,
        delta: Math.round(delta * 10) / 10,
        direction: delta >= 0 ? 'improved' : 'degraded' as 'improved' | 'degraded',
        main_dimension: dominantDimension(account, yesterday),
      }
    }
  }

  return jsonResponse({
    data: {
      portfolio: {
        current_avg_health: currentAvgHealth,
        week_ago_avg_health: weekAgoAvgHealth,
        health_delta_7d: healthDelta7d,
        health_trend: healthTrend,
      },
      risk_accounts_7d: riskAccounts7d,
      p0_insights_count: p0InsightsRes.count ?? 0,
      insight_du_jour: insightDuJour,
    },
  })
}

// ── GET /dashboard-api/wins ──────────────────────────────────

async function handleWins(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
): Promise<Response> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  const [currentAccountsRes, weekAgoScoresRes, currentSegmentsRes, weekAgoSegmentsRes] = await Promise.all([
    supabase.from('accounts')
      .select('id, stripe_customer_id, display_name, health_score, product_usage_score, financial_score, engagement_score, contract_score')
      .eq('organization_id', orgId)
      .not('health_score', 'is', null)
      .gte('health_score', WIN_MIN_HEALTH)
      .limit(2000),

    supabase.from('score_history')
      .select('account_id, health_score, product_usage_score, financial_score, engagement_score, contract_score')
      .eq('organization_id', orgId)
      .eq('snapshot_date', sevenDaysAgo)
      .limit(2000),

    // Segments actuels (active memberships)
    supabase.from('segment_memberships')
      .select('account_id, account_segments(segment_type)')
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .limit(5000),

    // Segments il y a 7 jours (memberships ajoutés avant J-7 ou exités après J-7)
    supabase.from('segment_memberships')
      .select('account_id, account_segments(segment_type)')
      .eq('organization_id', orgId)
      .lt('added_at', sevenDaysAgo)
      .or(`exited_at.is.null,exited_at.gte.${sevenDaysAgo}`)
      .limit(5000),
  ])

  const currentAccounts = currentAccountsRes.data ?? []
  const weekAgoByAccount = new Map(
    (weekAgoScoresRes.data ?? []).map((s: { account_id: string }) => [s.account_id, s]),
  )

  // Map account_id → segment_type courant
  const currentSegmentByAccount = new Map<string, string>()
  for (const sm of (currentSegmentsRes.data ?? [])) {
    const seg = sm.account_segments as { segment_type: string } | null
    if (seg) currentSegmentByAccount.set(sm.account_id, seg.segment_type)
  }

  // Map account_id → segment_type il y a 7 jours
  const weekAgoSegmentByAccount = new Map<string, string>()
  for (const sm of (weekAgoSegmentsRes.data ?? [])) {
    const seg = sm.account_segments as { segment_type: string } | null
    if (seg) weekAgoSegmentByAccount.set(sm.account_id, seg.segment_type)
  }

  // Calculer les wins
  type Win = {
    account_id: string
    stripe_customer_id: string
    display_name: string | null
    health_score_now: number
    health_score_7d_ago: number
    health_delta: number
    main_dimension: Dimension
    segment_before: string | null
    segment_now: string | null
    segment_changed: boolean
  }

  const wins: Win[] = []

  for (const account of currentAccounts) {
    const weekAgo = weekAgoByAccount.get(account.id)
    if (!weekAgo || account.health_score === null || weekAgo.health_score === null) continue

    const delta = (account.health_score as number) - (weekAgo.health_score as number)
    if (delta < WIN_THRESHOLD) continue

    const segmentNow = currentSegmentByAccount.get(account.id) ?? null
    const segmentBefore = weekAgoSegmentByAccount.get(account.id) ?? null

    wins.push({
      account_id: account.id,
      stripe_customer_id: account.stripe_customer_id,
      display_name: account.display_name ?? null,
      health_score_now: account.health_score as number,
      health_score_7d_ago: weekAgo.health_score as number,
      health_delta: Math.round(delta * 10) / 10,
      main_dimension: dominantDimension(account, weekAgo),
      segment_before: segmentBefore,
      segment_now: segmentNow,
      segment_changed: segmentBefore !== segmentNow,
    })
  }

  // Trier par delta décroissant, limiter à MAX_WINS
  wins.sort((a, b) => b.health_delta - a.health_delta)

  return jsonResponse({ data: wins.slice(0, MAX_WINS) })
}
