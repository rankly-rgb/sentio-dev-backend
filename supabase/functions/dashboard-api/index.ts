// ============================================================
// Edge Function : dashboard-api
// Données agrégées pour la page "Aujourd'hui" : briefing matinal,
// wins de la semaine, benchmarks sectoriels et métriques de portefeuille.
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// GET /dashboard-api/briefing
//   Response 200 :
//     {
//       data: {
//         portfolio: {
//           current_avg_health: number | null,
//           week_ago_avg_health: number | null,
//           health_delta_7d: number | null,
//           health_trend: "up" | "down" | "stable" | "unknown"
//         },
//         risk_accounts_7d: number,
//         p0_insights_count: number,
//         insight_du_jour: {
//           account_id: string,
//           stripe_customer_id: string,
//           display_name: string | null,
//           health_score_now: number,
//           health_score_yesterday: number,
//           delta: number,
//           direction: "improved" | "degraded",
//           main_dimension: "payment_health" | "revenue_dynamics" | "contract_renewal" | null
//         } | null
//       }
//     }
//
// GET /dashboard-api/wins
//   Response 200 :
//     {
//       data: Array<{
//         account_id: string,
//         stripe_customer_id: string,
//         display_name: string | null,
//         health_score_now: number,
//         health_score_7d_ago: number,
//         health_delta: number,
//         main_dimension: "payment_health" | "revenue_dynamics" | "contract_renewal" | null,
//         segment_before: string | null,
//         segment_now: string | null,
//         segment_changed: boolean
//       }>
//     }
//
// GET /dashboard-api/benchmarks
//   Calcule NRR, taux de churn et croissance MRR sur 12 mois glissants
//   et les compare aux standards du marché SaaS B2B (sources 2025).
//
//   Response 200 :
//     {
//       data: {
//         nrr: {
//           value: number | null,       // % (ex: 105.2)
//           rating: "excellent" | "bon" | "correct" | "mediocre" | null,
//           thresholds: { excellent: 120, bon: 105, correct: 90 },
//           higher_is_better: true,
//           sources: string[]
//         },
//         churn_rate: {
//           value: number | null,       // % revenue churn annuel (ex: 4.5)
//           rating: "excellent" | "bon" | "correct" | "mediocre" | null,
//           thresholds: { excellent: 3, bon: 5, correct: 10 },
//           higher_is_better: false,
//           sources: string[]
//         },
//         mrr_growth: {
//           value: number | null,       // % croissance MRR 12 mois (ex: 32.1)
//           rating: "excellent" | "bon" | "correct" | "mediocre" | null,
//           thresholds: { excellent: 50, bon: 25, correct: 10 },
//           higher_is_better: true,
//           sources: string[]
//         },
//         peers:
//           | { available: false, min_orgs_required: 3 }
//           | {
//               available: true,
//               org_count: number,
//               computed_at: string,
//               nrr: { p25: number, p50: number, p75: number },
//               churn_rate: { p25: number, p50: number, p75: number },
//               mrr_growth: { p25: number, p50: number, p75: number }
//             }
//       }
//     }
//
// GET /dashboard-api/portfolio-metrics
//   Endpoint métriques autoritaire du portefeuille (Phase 4, docs/openspec.md) —
//   toutes les définitions exactes sont dans API_CONTRACTS.md, pas dupliquées ici.
//
//   Response 200 :
//     {
//       data: {
//         mrr_cents: number,
//         arr_cents: number,
//         trial_mrr_cents: number,
//         nrr_percentage: number | null,
//         churn_rate: number | null,
//         accounts_at_risk: number,
//         mrr_at_risk_cents: number,
//         expansion_opportunities: number,
//         currency: string | null,
//         mrr_unavailable_accounts: number,
//         billing_profile: "standard" | "needs_review" | null,
//         stripe_stale: boolean
//       }
//     }
//
// Auth : JWT utilisateur vérifié dans le code (ES256 via verifyUserAuth)
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { calcNrrPercentage, calcChurnRate30d, type MrrMovementForNrr } from '../_shared/mrr-engine.ts'
import { computeSyncFreshness } from '../_shared/sync-freshness.ts'

// Seuil minimum pour qualifier un "win" (en points de health_score)
const WIN_THRESHOLD = 10
// Score minimum pour qu'un compte soit considéré "sain" après le win
const WIN_MIN_HEALTH = 50
// Nb max de wins retournés
const MAX_WINS = 5
// Segments considérés "à risque"
const RISK_SEGMENT_TYPES = ['en_danger_critique', 'a_risque_leger', 'en_churn', 'impayes']

// Scoring Engine V2 (model_version 'v3') : payment_health/revenue_dynamics/
// contract_renewal remplacent usage/financial/engagement/contract. Une
// dimension `null` (unavailable) d'un côté ou de l'autre est exclue de la
// comparaison plutôt que remplacée par un défaut 50/0 (S1) — inventer un
// delta sur une donnée absente produirait un "principal facteur de
// variation" mensonger.
type Dimension = 'payment_health' | 'revenue_dynamics' | 'contract_renewal'

function dominantDimension(
  now: Record<string, number | null>,
  before: Record<string, number | null>,
): Dimension | null {
  const pairs: Array<[Dimension, number | null, number | null]> = [
    ['payment_health', now.payment_health_score, before.payment_health_score],
    ['revenue_dynamics', now.revenue_dynamics_score, before.revenue_dynamics_score],
    ['contract_renewal', now.contract_renewal_score, before.contract_renewal_score],
  ]

  const deltas = pairs
    .filter((p): p is [Dimension, number, number] => p[1] !== null && p[2] !== null)
    .map(([dim, n, b]) => [dim, Math.abs(n - b)] as [Dimension, number])

  if (deltas.length === 0) return null
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
  if (path === 'benchmarks') return handleBenchmarks(supabase, orgId)
  if (path === 'portfolio-metrics') return handlePortfolioMetrics(supabase, orgId)

  return errorResponse('Not found. Use /dashboard-api/briefing, /dashboard-api/wins, /dashboard-api/benchmarks or /dashboard-api/portfolio-metrics', 404)
})

// ── GET /dashboard-api/briefing ──────────────────────────────

// D1/C2.2 (2026-08-02) : un compte churné n'est pas "à risque", il est
// perdu — un insight critique resté actif sur un compte déjà churné (avant
// que le prochain run de generate-insights ne l'auto-résolve) ne doit pas
// gonfler p0_insights_count. Même logique que get-today-status/index.ts.
function countCriticalExcludingChurned(
  insightAccountIds: Array<string | null>,
  churnedAccountIds: Set<string>,
): number {
  return insightAccountIds.filter((id) => id !== null && !churnedAccountIds.has(id)).length
}

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
    churnedAccountsRes,
    snapshotRes,
    orgBillingProfileRes,
  ] = await Promise.all([
    // Scores actuels par compte (nécessaire pour insight_du_jour, pas pour la moyenne)
    supabase.from('accounts')
      .select('id, stripe_customer_id, display_name, health_score, payment_health_score, revenue_dynamics_score, contract_renewal_score')
      .eq('organization_id', orgId)
      .not('health_score', 'is', null)
      .limit(2000),

    // Scores J-7 depuis score_history
    supabase.from('score_history')
      .select('account_id, health_score, payment_health_score, revenue_dynamics_score, contract_renewal_score')
      .eq('organization_id', orgId)
      .eq('snapshot_date', sevenDaysAgo)
      .limit(2000),

    // Scores J-1 pour insight du jour
    supabase.from('score_history')
      .select('account_id, health_score, payment_health_score, revenue_dynamics_score, contract_renewal_score')
      .eq('organization_id', orgId)
      .eq('snapshot_date', yesterday)
      .limit(2000),

    // Segments à risque de l'org (pour compter nouveaux entrants J-7)
    supabase.from('account_segments')
      .select('id')
      .eq('organization_id', orgId)
      .in('segment_type', RISK_SEGMENT_TYPES),

    // Insights P0 (critical actifs) — account_id (pas un count) pour pouvoir
    // exclure les comptes churnés ci-dessous (D1/C2.2).
    supabase.from('ai_insights')
      .select('account_id')
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .eq('priority', 'critical')
      .limit(5000),

    // D1/C2.2 : ids des comptes churnés, pour exclure leurs insights actifs
    // de p0_insights_count — un compte parti n'est pas "à risque".
    supabase.from('accounts')
      .select('id')
      .eq('organization_id', orgId)
      .eq('churn_risk_band', 'churned')
      .limit(20000),

    // Snapshot portefeuille partagé (chantier 5.1) — source de current_avg_health
    supabase.rpc('get_portfolio_snapshot', { p_organization_id: orgId }).maybeSingle(),

    // Phase 3 (docs/openspec.md §11) : profil de facturation détecté par sync-stripe
    supabase.from('organizations').select('billing_profile').eq('id', orgId).maybeSingle(),
  ])

  // ── Portfolio health delta ────────────────────────────────
  const currentAccounts = currentAccountsRes.data ?? []
  const weekAgoByAccount = new Map(
    (weekAgoScoresRes.data ?? []).map((s: { account_id: string; health_score: number | null }) => [s.account_id, s]),
  )

  const snapshot = snapshotRes.data as { avg_health_score: number | null } | null
  const currentAvgHealth: number | null = snapshot?.avg_health_score ?? null
  let weekAgoAvgHealth: number | null = null

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
      p0_insights_count: countCriticalExcludingChurned(
        (p0InsightsRes.data ?? []).map((i: { account_id: string | null }) => i.account_id),
        new Set((churnedAccountsRes.data ?? []).map((a: { id: string }) => a.id)),
      ),
      insight_du_jour: insightDuJour,
      billing_profile: (orgBillingProfileRes.data as { billing_profile?: string } | null)?.billing_profile ?? null,
    },
  })
}

// ── GET /dashboard-api/portfolio-metrics ─────────────────────
// Endpoint métriques autoritaire (Phase 4, docs/openspec.md) : tous les
// champs sont précalculés côté serveur — le frontend ne doit plus jamais
// recalculer un total de portefeuille lui-même (AUDIT_LOGIQUE_METIER_
// STRIPE.md point 22). Chaque champ documenté avec sa définition exacte
// dans API_CONTRACTS.md — ces définitions alimentent les tooltips (Phase 5.4).

const EXPANSION_OPPORTUNITY_THRESHOLD = 75 // cohérent avec kpi-cards.tsx historique (frontend, Phase 5.2)
const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

async function handlePortfolioMetrics(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
): Promise<Response> {
  const now = Date.now()
  const thirtyDaysAgoDate = new Date(now - THIRTY_DAYS_MS).toISOString().split('T')[0]

  const [
    accountsRes,
    allMovementsRes,
    last30dMovementsRes,
    firstMovementRes,
    orgRes,
    stripeFreshness,
  ] = await Promise.all([
    supabase.from('accounts')
      .select('mrr_cents, trial_mrr_cents, mrr_status, churn_risk_band, expansion_score, expansion_score_status')
      .eq('organization_id', orgId)
      .limit(20000),
    // NRR : historique complet, 'correction' exclu par construction (jamais
    // écrit par aucun chemin normal — filet de sécurité explicite ici aussi).
    supabase.from('mrr_movements')
      .select('movement_type, amount_cents')
      .eq('organization_id', orgId)
      .neq('movement_type', 'correction')
      .limit(50000),
    supabase.from('mrr_movements')
      .select('movement_type, amount_cents')
      .eq('organization_id', orgId)
      .neq('movement_type', 'correction')
      .gte('movement_date', thirtyDaysAgoDate)
      .limit(20000),
    supabase.from('mrr_movements')
      .select('movement_date')
      .eq('organization_id', orgId)
      .order('movement_date', { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase.from('organizations')
      .select('currency, billing_profile, created_at')
      .eq('id', orgId)
      .maybeSingle(),
    computeSyncFreshness(supabase, orgId, 'stripe'),
  ])

  if (accountsRes.error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'dashboard-api', route: 'portfolio-metrics', message: accountsRes.error.message }))
    return errorResponse('Failed to fetch accounts', 500)
  }

  const accounts = accountsRes.data ?? []
  const mrrCents = accounts.reduce((sum: number, a: { mrr_cents: number | null }) => sum + (a.mrr_cents ?? 0), 0)
  const trialMrrCents = accounts.reduce((sum: number, a: { trial_mrr_cents: number | null }) => sum + (a.trial_mrr_cents ?? 0), 0)
  const mrrUnavailableAccounts = accounts.filter((a: { mrr_status: string | null }) => a.mrr_status === 'unavailable').length

  const atRiskAccounts = accounts.filter((a: { churn_risk_band: string | null }) => a.churn_risk_band === 'high')
  const mrrAtRiskCents = atRiskAccounts.reduce((sum: number, a: { mrr_cents: number | null }) => sum + (a.mrr_cents ?? 0), 0)

  const expansionOpportunities = accounts.filter((a: { expansion_score_status: string | null; expansion_score: number | null }) =>
    a.expansion_score_status === 'available' && (a.expansion_score ?? 0) > EXPANSION_OPPORTUNITY_THRESHOLD,
  ).length

  // Au moins 3 mois d'historique : premier mouvement MRR connu, ou à
  // défaut date de création de l'org (aucun mouvement pour une org neuve
  // n'est pas "3 mois d'historique" non plus — created_at reste le plancher).
  const firstMovementDate = firstMovementRes.data?.movement_date ?? orgRes.data?.created_at ?? null
  const hasThreeMonthsHistory = firstMovementDate !== null && (now - new Date(firstMovementDate).getTime()) >= THREE_MONTHS_MS

  const allMovements: MrrMovementForNrr[] = (allMovementsRes.data ?? []) as MrrMovementForNrr[]
  const last30dMovements: MrrMovementForNrr[] = (last30dMovementsRes.data ?? []) as MrrMovementForNrr[]

  const nrrPercentage = calcNrrPercentage(mrrCents, allMovements, hasThreeMonthsHistory)
  const churnRate = calcChurnRate30d(mrrCents, last30dMovements)

  return jsonResponse({
    data: {
      mrr_cents: mrrCents,
      arr_cents: mrrCents * 12,
      trial_mrr_cents: trialMrrCents,
      nrr_percentage: nrrPercentage,
      churn_rate: churnRate,
      accounts_at_risk: atRiskAccounts.length,
      mrr_at_risk_cents: mrrAtRiskCents,
      expansion_opportunities: expansionOpportunities,
      currency: orgRes.data?.currency ?? null,
      mrr_unavailable_accounts: mrrUnavailableAccounts,
      billing_profile: orgRes.data?.billing_profile ?? null,
      stripe_stale: stripeFreshness.stale,
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
      .select('id, stripe_customer_id, display_name, health_score, payment_health_score, revenue_dynamics_score, contract_renewal_score')
      .eq('organization_id', orgId)
      .not('health_score', 'is', null)
      .gte('health_score', WIN_MIN_HEALTH)
      .limit(2000),

    supabase.from('score_history')
      .select('account_id, health_score, payment_health_score, revenue_dynamics_score, contract_renewal_score')
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
    main_dimension: Dimension | null
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

// ── GET /dashboard-api/benchmarks ───────────────────────────
// Seuils issus des rapports publiés 2025 :
//   NRR       : OpenView 2025, Bessemer Cloud Index
//   Churn     : Recurly 2025, ProfitWell
//   Croissance: SaaS Capital 2025

const NRR_THRESHOLDS = { excellent: 120, bon: 105, correct: 90 } as const
const CHURN_THRESHOLDS = { excellent: 3, bon: 5, correct: 10 } as const
const GROWTH_THRESHOLDS = { excellent: 50, bon: 25, correct: 10 } as const

type Rating = 'excellent' | 'bon' | 'correct' | 'mediocre'

function rateHigher(
  value: number | null,
  t: { excellent: number; bon: number; correct: number },
): Rating | null {
  if (value === null) return null
  if (value >= t.excellent) return 'excellent'
  if (value >= t.bon) return 'bon'
  if (value >= t.correct) return 'correct'
  return 'mediocre'
}

function rateLower(
  value: number | null,
  t: { excellent: number; bon: number; correct: number },
): Rating | null {
  if (value === null) return null
  if (value <= t.excellent) return 'excellent'
  if (value <= t.bon) return 'bon'
  if (value <= t.correct) return 'correct'
  return 'mediocre'
}

async function handleBenchmarks(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
): Promise<Response> {
  const now = Date.now()
  const twelveMonthsAgo = new Date(now - 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0]

  const [snapshotRes, movements12mRes, peersRes, firstMovementRes, orgRes] = await Promise.all([
    // Snapshot portefeuille partagé (chantier 5.1) — source de MRR actuel
    supabase.rpc('get_portfolio_snapshot', { p_organization_id: orgId }).maybeSingle(),

    supabase
      .from('mrr_movements')
      .select('movement_type, amount_cents')
      .eq('organization_id', orgId)
      .gte('movement_date', twelveMonthsAgo)
      .limit(10000),

    // Dernier snapshot peers disponible
    supabase
      .from('peer_benchmarks')
      .select('org_count, computed_at, nrr_p25, nrr_p50, nrr_p75, churn_rate_p25, churn_rate_p50, churn_rate_p75, mrr_growth_p25, mrr_growth_p50, mrr_growth_p75')
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),

    // Bootstrap : même garde que portfolio-metrics (calcNrrPercentage) — un
    // NRR n'a de sens qu'avec au moins 3 mois d'historique réel, jamais un
    // 100 déguisé en "pas d'historique = neutre" (Problème 1, audit 2026-08).
    supabase.from('mrr_movements')
      .select('movement_date')
      .eq('organization_id', orgId)
      .order('movement_date', { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase.from('organizations')
      .select('created_at')
      .eq('id', orgId)
      .maybeSingle(),
  ])

  // MRR actuel total
  const currentMrr = (snapshotRes.data as { total_mrr_cents: number } | null)?.total_mrr_cents ?? 0

  // Agréger les mouvements par type
  let new12m = 0, expansion12m = 0, contraction12m = 0, churn12m = 0, reactivation12m = 0
  for (const m of (movements12mRes.data ?? [])) {
    const amt = m.amount_cents ?? 0
    switch (m.movement_type) {
      case 'new': new12m += amt; break
      case 'expansion': expansion12m += amt; break
      case 'contraction': contraction12m += amt; break
      case 'churn': churn12m += amt; break
      case 'reactivation': reactivation12m += amt; break
    }
  }

  // MRR de départ (il y a 12 mois) = MRR actuel - mouvements nets sur 12 mois
  const netMovements12m = new12m + expansion12m + reactivation12m - contraction12m - churn12m
  const startingMrr = currentMrr - netMovements12m

  const firstMovementDate = firstMovementRes.data?.movement_date ?? orgRes.data?.created_at ?? null
  const hasThreeMonthsHistory = firstMovementDate !== null && (now - new Date(firstMovementDate).getTime()) >= THREE_MONTHS_MS

  // NRR : déléguée à calcNrrPercentage (_shared/mrr-engine.ts) — même formule
  // et même garde bootstrap que /portfolio-metrics, plutôt qu'un second
  // calculateur local. Avant ce correctif, ce chemin retournait `100` en
  // l'absence d'historique ("pas d'historique = neutre"), un faux positif
  // (Problème 1, audit 2026-08) : calcNrrPercentage retourne `null` dans ce
  // cas, jamais un 100 qui se lirait comme "rétention parfaite".
  const nrr = calcNrrPercentage(currentMrr, (movements12mRes.data ?? []) as MrrMovementForNrr[], hasThreeMonthsHistory)

  // Churn rate revenue = MRR churné / MRR de départ × 100 (plafonné à 100%)
  const churnRate = startingMrr > 0
    ? Math.min(100, Math.round((churn12m / startingMrr) * 1000) / 10)
    : 0

  // Croissance MRR = mouvements nets / MRR de départ × 100
  const mrrGrowth: number | null = startingMrr > 0
    ? Math.round((netMovements12m / startingMrr) * 1000) / 10
    : null

  // Peers : snapshot le plus récent si disponible
  const peerRow = peersRes.data
  const peers = peerRow
    ? {
        available: true as const,
        org_count: peerRow.org_count,
        computed_at: peerRow.computed_at,
        nrr: { p25: peerRow.nrr_p25, p50: peerRow.nrr_p50, p75: peerRow.nrr_p75 },
        churn_rate: { p25: peerRow.churn_rate_p25, p50: peerRow.churn_rate_p50, p75: peerRow.churn_rate_p75 },
        mrr_growth: { p25: peerRow.mrr_growth_p25, p50: peerRow.mrr_growth_p50, p75: peerRow.mrr_growth_p75 },
      }
    : { available: false as const, min_orgs_required: 3 }

  return jsonResponse({
    data: {
      nrr: {
        value: nrr,
        rating: rateHigher(nrr, NRR_THRESHOLDS),
        thresholds: NRR_THRESHOLDS,
        higher_is_better: true,
        sources: ['OpenView 2025', 'Bessemer Cloud Index'],
      },
      churn_rate: {
        value: churnRate,
        rating: rateLower(churnRate, CHURN_THRESHOLDS),
        thresholds: CHURN_THRESHOLDS,
        higher_is_better: false,
        sources: ['Recurly 2025', 'ProfitWell'],
      },
      mrr_growth: {
        value: mrrGrowth,
        rating: rateHigher(mrrGrowth, GROWTH_THRESHOLDS),
        thresholds: GROWTH_THRESHOLDS,
        higher_is_better: true,
        sources: ['SaaS Capital 2025'],
      },
      peers,
    },
  })
}
