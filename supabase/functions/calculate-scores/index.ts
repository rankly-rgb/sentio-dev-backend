// ============================================================
// Edge Function : calculate-scores
// Calcule quotidiennement les scores Health/Churn/Expansion
// pour chaque account, assigne les segments, et persiste
// dans score_history + account_segments.
//
// Scoring Engine V2 (model_version 'v3' — voir migration
// 20260725000001_scoring_engine_v3.sql) :
//   Health  = Σ(dimension_score × poids org) sur payment_health(35)/
//             revenue_dynamics(35)/contract_renewal(30), dimensions
//             disponibles uniquement — pas de renormalisation entre
//             dimensions, pas de défaut 50 si donnée absente (S1/S4).
//   Churn   = score additif de signaux de risque déterministes,
//             découplé du Health Score (S5) — plus de "100 - health".
//   Expansion = seat_usage_pct seul (via stripe_product_mappings),
//             NULL explicite si non configuré — jamais de cap silencieux (S6).
// ============================================================
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { DataSyncLogger } from '../_shared/data-sync-logger.ts'
import { acquireCronLock, releaseCronLock } from '../_shared/cron-lock.ts'
import { alertSlack } from '../_shared/slack-alert.ts'
import {
  type Account,
  type SegmentType,
  type InvoiceRecord,
  type MrrMovementRecord,
  type ScoringWeights,
  type SegmentInputV3,
  type SegmentTypeV3,
  type ChurnSignalInputs,
  type ScoreBreakdown,
  SYSTEM_SEGMENT_TYPES,
  DEFAULT_SCORING_WEIGHTS,
  validateScoringWeights,
  calcPaymentHealthDimension,
  calcRevenueDynamicsDimension,
  calcContractRenewalDimension,
  calcHealthScoreV3,
  calcChurnRiskV2,
  buildChurnSignals,
  countPaymentFailures90d,
  calcExpansionScoreV2,
  calcExpansionSignals,
  determineSegmentTypesV3,
  buildScoreBreakdown,
  computeTrend30d,
} from '../_shared/scoring.ts'
import { generateNarrativesV3 } from '../_shared/score-narratives.ts'
import { isAccountChurned } from '../_shared/mrr-engine.ts'

// ── Types internes ──────────────────────────────────────────
interface AccountWithCreatedAt extends Account {
  created_at: string
  stripe_customer_id?: string
  seat_count: number | null
  billing_interval: string | null
  contract_start_date: string | null
  churn_risk_band?: 'low' | 'watch' | 'high' | 'churned' | null
  health_score_status?: 'complete' | 'partial' | 'insufficient' | null
}

interface DispatchTask {
  account: AccountWithCreatedAt
  scores: ScoreResult
  oldSegment: string
  newSegment: string
  hasOverdue: boolean
}

// Scoring Engine V2 (model_version 'v3') — 3 dimensions Stripe-only, plus
// tous les champs "no data ≠ neutral" (S1) qui remplacent les anciens
// defaults 50/100 déguisés en scores réels.
interface ScoreResult {
  health_score: number | null
  health_score_status: 'complete' | 'partial' | 'insufficient'
  health_score_max_points: number
  health_score_band: 'healthy' | 'watch' | 'at_risk' | null
  churn_risk_score: number | null
  churn_risk_band: 'low' | 'watch' | 'high' | 'churned'
  risk_signals_triggered: Array<{ code: string; label: string; severity: string; points: number }>
  risk_signals_evaluated: number
  expansion_score: number | null
  expansion_score_status: 'available' | 'unavailable'
  expansion_unavailable_reason: string | null
  payment_health_score: number | null
  revenue_dynamics_score: number | null
  contract_renewal_score: number | null
  score_breakdown: ScoreBreakdown
  trend_30d: 'up' | 'flat' | 'down'
}

// ── Helper : segment primaire (hors 'nouveaux' non-exclusif) ────────────────
function getPrimarySegment(segTypes: SegmentTypeV3[]): string {
  const nonNew = segTypes.filter((t) => t !== 'nouveaux')
  return (nonNew[0] ?? segTypes[0] ?? 'stables') as string
}

// Segment primaire "avant ce run", dérivé du dernier churn_risk_band/
// health_score_status persistés sur accounts (pas de recalcul complet — on
// ne rejoue pas l'historique des factures/mouvements passés). Un compte
// jamais scoré (colonnes NULL) reçoit le sentinel 'jamais_score' plutôt que
// le défaut déguisé `?? 50` de l'implémentation V1 — ce qui déclenche
// naturellement le dispatch webhook/playbook au premier scoring réussi.
function getPreviousPrimarySegment(account: AccountWithCreatedAt): string {
  if ((account.mrr_cents ?? 0) === 0) return 'en_churn'
  if (account.churn_risk_band === null || account.churn_risk_band === undefined) return 'jamais_score'
  if (account.churn_risk_band === 'high') return 'en_danger_critique'
  if (account.churn_risk_band === 'watch') return 'a_risque_leger'
  return 'stables'
}

// ── Segment definitions (mirrored in migration) ─────────────
// 'en_expansion' n'est plus assigné par determineSegmentTypesV3 (fusionné
// dans 'champions', voir scoring.ts) mais la définition reste ici pour ne
// pas casser un éventuel lien existant depuis account_segments — la ligne
// n'accumulera simplement plus jamais de nouveaux memberships.
const SEGMENT_DEFINITIONS: Array<{
  segment_name: string
  segment_type: SegmentType
  priority: string
  criteria: Record<string, unknown>
  description: string
}> = [
  { segment_name: 'Champions', segment_type: 'champions', priority: 'high', criteria: { health_score_band: 'healthy', has_expansion_signal: true }, description: 'Accounts in excellent health with active expansion signals' },
  { segment_name: 'Expanding', segment_type: 'en_expansion', priority: 'medium', criteria: { retired_v3: true }, description: '[Retired in Scoring V2 — merged into Champions]' },
  { segment_name: 'Stable', segment_type: 'stables', priority: 'low', criteria: { churn_risk_band: 'low' }, description: 'Stable accounts with no risk' },
  { segment_name: 'Slightly at Risk', segment_type: 'a_risque_leger', priority: 'medium', criteria: { churn_risk_band: 'watch' }, description: 'Accounts showing signs of risk' },
  { segment_name: 'Critical Danger', segment_type: 'en_danger_critique', priority: 'critical', criteria: { churn_risk_band: 'high' }, description: 'Accounts in imminent danger of churning' },
  { segment_name: 'Unpaid', segment_type: 'impayes', priority: 'critical', criteria: { has_overdue_invoices: true }, description: 'Accounts with overdue invoices' },
  { segment_name: 'Churned', segment_type: 'en_churn', priority: 'critical', criteria: { mrr_cents_eq: 0 }, description: 'Accounts that have churned' },
  { segment_name: 'New (< 90d)', segment_type: 'nouveaux', priority: 'low', criteria: { days_since_creation_lt: 90 }, description: 'Accounts created less than 90 days ago' },
  { segment_name: 'Insufficient Data', segment_type: 'donnees_insuffisantes', priority: 'medium', criteria: { health_score_status: 'insufficient' }, description: 'Accounts with less than 50% of health score dimensions available — never appears alongside another health segment' },
]

// ── Ensure system segments exist for an org ──────────────────
async function ensureSystemSegments(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<Map<SegmentType, string>> {
  const { data: existing } = await supabase
    .from('account_segments')
    .select('id, segment_type')
    .eq('organization_id', organizationId)
    .eq('is_system_generated', true)

  const segmentMap = new Map<SegmentType, string>()
  const existingTypes = new Set<string>()

  for (const seg of existing ?? []) {
    segmentMap.set(seg.segment_type as SegmentType, seg.id)
    existingTypes.add(seg.segment_type)
  }

  const missing = SEGMENT_DEFINITIONS.filter((d) => !existingTypes.has(d.segment_type))

  if (missing.length > 0) {
    const { data: created } = await supabase
      .from('account_segments')
      .insert(
        missing.map((d) => ({
          organization_id: organizationId,
          segment_name: d.segment_name,
          segment_type: d.segment_type,
          priority: d.priority,
          criteria: d.criteria,
          description: d.description,
          is_system_generated: true,
          is_active: true,
        })),
      )
      .select('id, segment_type')

    for (const seg of created ?? []) {
      segmentMap.set(seg.segment_type as SegmentType, seg.id)
    }
  }

  return segmentMap
}

// ── Batch size for paginated scoring ────────────────────────────
const SCORING_BATCH_SIZE = 500
const MAX_BATCHES = 200 // Safety guard: 200 * 500 = 100k accounts max per org

const MODEL_VERSION = 'v3' // Scoring Engine V2 (produit) — voir migration 20260725000001

interface SubscriptionInfo {
  status: string
  stripe_price_id: string | null
}

interface SeatMapping {
  seat_limit: number | null
  unlimited_seats: boolean
}

// ── Pre-fetch scoring data for a batch of accounts (parallel bulk queries instead of N+1) ──
async function prefetchScoringData(
  supabase: SupabaseClient,
  accountIds: string[],
): Promise<{
  invoices90dMap: Map<string, InvoiceRecord[]>
  invoices12moMap: Map<string, InvoiceRecord[]>
  movements6moMap: Map<string, MrrMovementRecord[]>
  subscriptionsMap: Map<string, SubscriptionInfo[]>
  mrr3moAgoMap: Map<string, number>
  healthScore30dAgoMap: Map<string, number>
  overdueCountMap: Map<string, number>
  overdueAmountMap: Map<string, number>
}> {
  const now = new Date()
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86400000).toISOString().split('T')[0]
  const twelveMonthsAgo = new Date(now.getTime() - 365 * 86400000).toISOString().split('T')[0]
  const sixMonthsAgo = new Date(now.getTime() - 182 * 86400000).toISOString().split('T')[0]
  // Fenêtre de snapshot "il y a 3 mois" tolérante (83-97j) : le run quotidien
  // ne tombe pas forcément exactement 90j avant aujourd'hui pour un compte donné.
  const snapshot3moStart = new Date(now.getTime() - 97 * 86400000).toISOString().split('T')[0]
  const snapshot3moEnd = new Date(now.getTime() - 83 * 86400000).toISOString().split('T')[0]
  // Fenêtre "il y a 30 jours" tolérante (27-33j) pour trend_30d (S8).
  const snapshot30dStart = new Date(now.getTime() - 33 * 86400000).toISOString().split('T')[0]
  const snapshot30dEnd = new Date(now.getTime() - 27 * 86400000).toISOString().split('T')[0]

  const [invoices12moResult, movementsResult, subscriptionsResult, snapshot3moResult, snapshot30dResult] = await Promise.all([
    supabase
      .from('invoices')
      .select('account_id, status, due_date, paid_at, invoice_date, amount_cents')
      .in('account_id', accountIds)
      .gte('invoice_date', twelveMonthsAgo)
      .limit(50000),
    supabase
      .from('mrr_movements')
      .select('account_id, movement_type, amount_cents, movement_date')
      .in('account_id', accountIds)
      .gte('movement_date', sixMonthsAgo)
      .limit(50000),
    supabase
      .from('subscriptions')
      .select('account_id, status, stripe_price_id')
      .in('account_id', accountIds)
      .limit(50000),
    supabase
      .from('score_history')
      .select('account_id, mrr_cents, snapshot_date')
      .in('account_id', accountIds)
      .gte('snapshot_date', snapshot3moStart)
      .lte('snapshot_date', snapshot3moEnd)
      .order('snapshot_date', { ascending: true }),
    supabase
      .from('score_history')
      .select('account_id, health_score, snapshot_date')
      .in('account_id', accountIds)
      .gte('snapshot_date', snapshot30dStart)
      .lte('snapshot_date', snapshot30dEnd)
      .order('snapshot_date', { ascending: true }),
  ])

  const invoices90dMap = new Map<string, InvoiceRecord[]>()
  const invoices12moMap = new Map<string, InvoiceRecord[]>()
  const overdueCountMap = new Map<string, number>()
  const overdueAmountMap = new Map<string, number>()

  for (const row of (invoices12moResult.data ?? [])) {
    const rec: InvoiceRecord = {
      status: row.status,
      due_date: row.due_date,
      paid_at: row.paid_at,
      invoice_date: row.invoice_date,
    }
    const list12mo = invoices12moMap.get(row.account_id) ?? []
    list12mo.push(rec)
    invoices12moMap.set(row.account_id, list12mo)

    if (row.invoice_date >= ninetyDaysAgo) {
      const list90d = invoices90dMap.get(row.account_id) ?? []
      list90d.push(rec)
      invoices90dMap.set(row.account_id, list90d)
    }

    if ((row.status === 'open' || row.status === 'uncollectible') && row.due_date && row.due_date < now.toISOString().split('T')[0]) {
      overdueCountMap.set(row.account_id, (overdueCountMap.get(row.account_id) ?? 0) + 1)
      overdueAmountMap.set(row.account_id, (overdueAmountMap.get(row.account_id) ?? 0) + (row.amount_cents ?? 0))
    }
  }

  const movements6moMap = new Map<string, MrrMovementRecord[]>()
  for (const row of (movementsResult.data ?? [])) {
    const list = movements6moMap.get(row.account_id) ?? []
    list.push({ movement_type: row.movement_type, amount_cents: row.amount_cents, movement_date: row.movement_date })
    movements6moMap.set(row.account_id, list)
  }

  const subscriptionsMap = new Map<string, SubscriptionInfo[]>()
  for (const row of (subscriptionsResult.data ?? [])) {
    const list = subscriptionsMap.get(row.account_id) ?? []
    list.push({ status: row.status, stripe_price_id: row.stripe_price_id })
    subscriptionsMap.set(row.account_id, list)
  }

  // Premier snapshot dans la fenêtre 83-97j par compte = "MRR il y a 3 mois".
  const mrr3moAgoMap = new Map<string, number>()
  for (const row of (snapshot3moResult.data ?? [])) {
    if (!mrr3moAgoMap.has(row.account_id) && row.mrr_cents !== null) {
      mrr3moAgoMap.set(row.account_id, row.mrr_cents)
    }
  }

  // Premier snapshot dans la fenêtre 27-33j par compte = "health_score il y a 30 jours" (S8 trend_30d).
  const healthScore30dAgoMap = new Map<string, number>()
  for (const row of (snapshot30dResult.data ?? [])) {
    if (!healthScore30dAgoMap.has(row.account_id) && row.health_score !== null) {
      healthScore30dAgoMap.set(row.account_id, row.health_score)
    }
  }

  return { invoices90dMap, invoices12moMap, movements6moMap, subscriptionsMap, mrr3moAgoMap, healthScore30dAgoMap, overdueCountMap, overdueAmountMap }
}

// ── Seat usage % via stripe_product_mappings (S6 — jamais de cap silencieux) ──
function computeSeatUsagePct(
  seatCount: number | null,
  activePriceId: string | null,
  mappingsByPriceId: Map<string, SeatMapping>,
): { seatUsagePct: number | null; reason: string | null } {
  if (!activePriceId) return { seatUsagePct: null, reason: 'seat_data_not_configured' }
  const mapping = mappingsByPriceId.get(activePriceId)
  if (!mapping) return { seatUsagePct: null, reason: 'seat_data_not_configured' }
  if (mapping.unlimited_seats) return { seatUsagePct: null, reason: 'unlimited_plan_no_ceiling' }
  if (!mapping.seat_limit || mapping.seat_limit <= 0) return { seatUsagePct: null, reason: 'seat_data_not_configured' }
  if (seatCount === null) return { seatUsagePct: null, reason: 'seat_data_not_configured' }
  return { seatUsagePct: Math.min(100, (seatCount / mapping.seat_limit) * 100), reason: null }
}

// ── Scoring d'un compte (pure — no DB calls) ────────────────────
interface ScoreAccountInput {
  account: AccountWithCreatedAt
  invoices90d: InvoiceRecord[]
  invoices12mo: InvoiceRecord[]
  movements6mo: MrrMovementRecord[]
  mrr3moAgoCents: number | null
  healthScore30dAgo: number | null
  subscriptions: SubscriptionInfo[]
  seatUsagePct: number | null
  seatUsageUnavailableReason: string
  weights: ScoringWeights
}

interface ScoreAccountOutput {
  scores: ScoreResult
  expansionSignals: { has_upgrade_event: boolean; has_expansion_mrr_event: boolean; invoice_growth_detected: boolean }
  hasOverdueInvoices: boolean
  subscriptionCanceled: boolean
}

function scoreAccountPure(input: ScoreAccountInput, now: number = Date.now()): ScoreAccountOutput {
  const { account, invoices90d, invoices12mo, movements6mo, mrr3moAgoCents, healthScore30dAgo, subscriptions, seatUsagePct, seatUsageUnavailableReason, weights } = input
  const mrrCurrentCents = account.mrr_cents ?? 0

  // ── Dimensions ──
  const paymentHealth = calcPaymentHealthDimension({ invoices90d, invoices12mo }, now)
  const revenueDynamics = calcRevenueDynamicsDimension({ mrrCurrentCents, mrr3moAgoCents, movements6mo })
  const contractRenewal = calcContractRenewalDimension(
    {
      billingInterval: account.billing_interval === 'monthly' || account.billing_interval === 'annual' ? account.billing_interval : null,
      contractEndDate: account.contract_end_date,
      contractStartDate: account.contract_start_date,
    },
    now,
  )

  const health = calcHealthScoreV3({ paymentHealth, revenueDynamics, contractRenewal }, weights)
  const scoreBreakdown = buildScoreBreakdown({ paymentHealth, revenueDynamics, contractRenewal }, weights)
  const trend30d = computeTrend30d(health.health_score_points, healthScore30dAgo)

  // ── Churn risk signals ──
  const overdue = invoices90d.filter((i) => (i.status === 'open' || i.status === 'uncollectible') && i.due_date)
  const overdueDays = overdue.map((i) => Math.floor((now - new Date(i.due_date as string).getTime()) / 86400000)).filter((d) => d > 0)
  const hasOverdue15Plus = overdueDays.some((d) => d >= 15)
  const hasOverdueUnder15 = overdueDays.some((d) => d > 0 && d < 15)
  const hasOverdueInvoices = hasOverdue15Plus || hasOverdueUnder15

  const movements3mo = movements6mo.filter((m) => (now - new Date(m.movement_date).getTime()) <= 91 * 86400000)
  const contraction3moTotal = movements3mo.filter((m) => m.movement_type === 'contraction').reduce((s, m) => s + Math.abs(m.amount_cents), 0)
  const contraction20PctPlus = mrrCurrentCents > 0 ? (contraction3moTotal / mrrCurrentCents) >= 0.20 : contraction3moTotal > 0
  const contraction6moTotal = movements6mo.filter((m) => m.movement_type === 'contraction').reduce((s, m) => s + Math.abs(m.amount_cents), 0)
  const hasContraction6mo = contraction6moTotal > 0

  const { total: failures90d } = invoices90d.length > 0 ? countPaymentFailures90d(invoices90d) : { total: null as unknown as number }
  const paymentFailures2Plus = invoices90d.length > 0 ? failures90d >= 2 : null

  const tenureMonths = account.contract_start_date
    ? (now - new Date(account.contract_start_date).getTime()) / (30 * 86400000)
    : null
  const isMonthly = account.billing_interval === 'monthly'
  const isAnnual = account.billing_interval === 'annual'
  const isMonthlyAndYoung = account.billing_interval ? (isMonthly && tenureMonths !== null ? tenureMonths < 6 : (isMonthly ? null : false)) : null

  let annualRenewalSoonWithContraction: boolean | null = null
  if (isAnnual && account.contract_end_date) {
    const daysUntilRenewal = Math.floor((new Date(account.contract_end_date).getTime() - now) / 86400000)
    annualRenewalSoonWithContraction = daysUntilRenewal >= 0 && daysUntilRenewal <= 30 && hasContraction6mo
  } else if (isAnnual && !account.contract_end_date) {
    annualRenewalSoonWithContraction = null
  } else {
    annualRenewalSoonWithContraction = false
  }

  const hasDowngrade6mo = movements6mo.some((m) => m.movement_type === 'contraction')

  const subscriptionCanceled = isAccountChurned(subscriptions.map((s) => s.status))

  // D1 (2026-08-02) : un compte churné sort du calcul de churn risk — état
  // figé 'churned', pas un score calculé sur des signaux historiques
  // (invoice/contraction/tenure passés). Un compte parti n'est pas "à
  // risque", il est perdu. churn_risk_score reste `null` (S1 : no data ≠
  // neutral data — pas un 0 qui se lirait comme "aucun risque"). Ne jamais
  // recalculer sur ce chemin, même si des signaux seraient techniquement
  // disponibles.
  //
  // D-NEXT (docs/openspec.md §5, correctif de l'intention de D1, voir
  // CLAUDE.md) : la branche `mrrCurrentCents === 0` est retirée. Elle
  // capturait aussi des comptes délinquants (past_due/unpaid — jamais
  // vraiment "partis", D1 les visait explicitement pas eux) et des comptes
  // en configuration Stripe non-standard où mrr_cents tombait à 0 par
  // angle mort du moteur plutôt que par départ réel (invoice-only,
  // usage-based non chiffré — AUDIT_LOGIQUE_METIER_STRIPE.md point 6/20).
  // isAccountChurned (_shared/mrr-engine.ts) = toutes les subscriptions du
  // compte sont 'canceled' : un compte sans aucune subscription connue
  // (invoice-only, ou pas encore synchronisé) n'est structurellement
  // jamais churned par défaut (subscriptions.length === 0 → false), un
  // compte metered/devise-minoritaire non plus (son unique subscription
  // reste 'active', jamais 'canceled').
  const isChurned = subscriptionCanceled

  let churn: { churn_risk_score: number | null; churn_risk_band: 'low' | 'watch' | 'high' | 'churned'; risk_signals_triggered: Array<{ code: string; label: string; severity: string; points: number }>; risk_signals_evaluated: number }

  if (isChurned) {
    churn = { churn_risk_score: null, churn_risk_band: 'churned', risk_signals_triggered: [], risk_signals_evaluated: 0 }
  } else {
    const signalInputs: ChurnSignalInputs = {
      hasInvoiceOverdue15Plus: invoices90d.length > 0 ? hasOverdue15Plus : null,
      contractionMrr20PctPlus3mo: movements6mo.length > 0 || mrrCurrentCents > 0 ? contraction20PctPlus : null,
      paymentFailures2PlusIn90d: paymentFailures2Plus,
      isMonthlyAndTenureUnder6mo: isMonthlyAndYoung,
      annualRenewal30dPlusWithContraction6mo: annualRenewalSoonWithContraction,
      hasDowngrade6mo: movements6mo.length > 0 ? hasDowngrade6mo : null,
      hasInvoiceOverdueUnder15: invoices90d.length > 0 ? hasOverdueUnder15 : null,
    }
    churn = calcChurnRiskV2(buildChurnSignals(signalInputs))
  }

  // ── Expansion ──
  const expansion = calcExpansionScoreV2(seatUsagePct, seatUsageUnavailableReason)
  const expansionSignals = calcExpansionSignals(movements6mo, mrrCurrentCents, mrr3moAgoCents)

  return {
    scores: {
      health_score: health.health_score_points,
      health_score_status: health.health_score_status,
      health_score_max_points: health.health_score_max_points,
      health_score_band: health.health_score_band,
      churn_risk_score: churn.churn_risk_score,
      churn_risk_band: churn.churn_risk_band,
      risk_signals_triggered: churn.risk_signals_triggered,
      risk_signals_evaluated: churn.risk_signals_evaluated,
      expansion_score: expansion.expansion_score,
      expansion_score_status: expansion.expansion_score_status,
      expansion_unavailable_reason: expansion.expansion_unavailable_reason,
      payment_health_score: paymentHealth.score,
      revenue_dynamics_score: revenueDynamics.score,
      contract_renewal_score: contractRenewal.score,
      score_breakdown: scoreBreakdown,
      trend_30d: trend30d,
    },
    expansionSignals,
    hasOverdueInvoices,
    subscriptionCanceled,
  }
}

// ── Assign segments after scoring ────────────────────────────
async function assignSegments(
  supabase: SupabaseClient,
  organizationId: string,
  accounts: AccountWithCreatedAt[],
  accountScores: Map<string, ScoreResult>,
  accountSegmentInputs: Map<string, SegmentInputV3>,
): Promise<{ segmentsAssigned: number; segmentsByAccount: Map<string, SegmentTypeV3[]> }> {
  const segmentMap = await ensureSystemSegments(supabase, organizationId)
  const systemSegmentIds = Array.from(segmentMap.values())

  if (systemSegmentIds.length === 0) return { segmentsAssigned: 0, segmentsByAccount: new Map() }

  // Build new memberships (upsert to avoid delete+insert visibility gap)
  const memberships: Array<Record<string, unknown>> = []
  const segmentAggs: Record<string, { count: number; mrrTotal: number; healthSum: number; healthCount: number; churnSum: number; churnCount: number }> = {}
  const segmentsByAccount = new Map<string, SegmentTypeV3[]>()
  // primary_segment (T0.2, accounts.primary_segment) : premier segment non-'nouveaux'
  // — même règle de priorité que accounts-api (fetchPrimarySegments). 'nouveaux' est
  // non-exclusif/additif et n'est jamais le segment primaire. Groupé par valeur pour
  // limiter le nombre d'UPDATE (un par segment de santé plutôt qu'un par compte).
  const accountIdsBySegment = new Map<SegmentTypeV3, string[]>()

  for (const segType of SYSTEM_SEGMENT_TYPES) {
    segmentAggs[segType] = { count: 0, mrrTotal: 0, healthSum: 0, healthCount: 0, churnSum: 0, churnCount: 0 }
  }

  const now = new Date().toISOString()

  for (const account of accounts) {
    const scores = accountScores.get(account.id)
    const segInput = accountSegmentInputs.get(account.id)
    if (!scores || !segInput) continue

    const segTypes = determineSegmentTypesV3(segInput)
    segmentsByAccount.set(account.id, segTypes)

    const primarySegType = segTypes.find((s) => s !== 'nouveaux')
    if (primarySegType) {
      const ids = accountIdsBySegment.get(primarySegType) ?? []
      ids.push(account.id)
      accountIdsBySegment.set(primarySegType, ids)
    }

    for (const segType of segTypes) {
      const segId = segmentMap.get(segType as SegmentType)
      if (!segId) continue

      memberships.push({
        organization_id: organizationId,
        segment_id: segId,
        account_id: account.id,
        status: 'active',
        source_type: 'ai_generated',
        risk_score: scores.churn_risk_score,
        last_evaluated_at: now,
      })

      const agg = segmentAggs[segType]
      agg.count++
      agg.mrrTotal += account.mrr_cents ?? 0
      // churn_risk_score est `null` pour les comptes churnés (D1) — exclu de
      // la moyenne plutôt que compté comme 0, même raison que health_score.
      if (scores.churn_risk_score !== null) {
        agg.churnSum += scores.churn_risk_score
        agg.churnCount++
      }
      // health_score peut être null (status='insufficient') — exclu de la
      // moyenne plutôt que compté comme 0 (S1 : no data ≠ neutral data).
      if (scores.health_score !== null) {
        agg.healthSum += scores.health_score
        agg.healthCount++
      }
    }
  }

  // Batch upsert memberships (atomic — no visibility gap)
  const newAccountSegmentPairs = new Set<string>()
  if (memberships.length > 0) {
    const CHUNK_SIZE = 100
    for (let i = 0; i < memberships.length; i += CHUNK_SIZE) {
      const { error } = await supabase
        .from('segment_memberships')
        .upsert(memberships.slice(i, i + CHUNK_SIZE), {
          onConflict: 'organization_id,segment_id,account_id',
          ignoreDuplicates: false,
        })

      if (error) {
        console.error('[calculate-scores] segment_memberships upsert error:', error.message)
      }
    }
    for (const m of memberships) {
      newAccountSegmentPairs.add(`${m.account_id}:${m.segment_id}`)
    }
  }

  // Persist accounts.primary_segment (T0.2) — un UPDATE par valeur de segment
  // plutôt que par compte (accountIdsBySegment.size <= 7 valeurs de santé possibles).
  for (const [segType, ids] of accountIdsBySegment) {
    const { error } = await supabase
      .from('accounts')
      .update({ primary_segment: segType })
      .eq('organization_id', organizationId)
      .in('id', ids)

    if (error) {
      console.error('[calculate-scores] accounts.primary_segment update error:', error.message)
    }
  }

  // Clean up stale memberships that are no longer valid
  const { data: existingMemberships } = await supabase
    .from('segment_memberships')
    .select('id, account_id, segment_id')
    .eq('organization_id', organizationId)
    .eq('source_type', 'ai_generated')
    .in('segment_id', systemSegmentIds)

  const staleIds = (existingMemberships ?? [])
    .filter((m: Record<string, unknown>) => !newAccountSegmentPairs.has(`${m.account_id}:${m.segment_id}`))
    .map((m: Record<string, unknown>) => m.id as string)

  if (staleIds.length > 0) {
    const { error: deleteError } = await supabase
      .from('segment_memberships')
      .delete()
      .in('id', staleIds)

    if (deleteError) {
      console.error('[calculate-scores] stale membership cleanup error:', deleteError.message)
    }
  }

  // Update segment aggregate metrics
  for (const [segType, agg] of Object.entries(segmentAggs)) {
    const segId = segmentMap.get(segType as SegmentType)
    if (!segId) continue

    await supabase
      .from('account_segments')
      .update({
        account_count: agg.count,
        mrr_total_cents: agg.mrrTotal,
        avg_health_score: agg.healthCount > 0 ? Math.round((agg.healthSum / agg.healthCount) * 100) / 100 : null,
        avg_churn_risk: agg.churnCount > 0 ? Math.round((agg.churnSum / agg.churnCount) * 100) / 100 : null,
        last_calculated_at: now,
      })
      .eq('id', segId)
  }

  return { segmentsAssigned: memberships.length, segmentsByAccount }
}

// ── Entrypoint ───────────────────────────────────────────────
Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'calculate-scores', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  let body: { organization_id?: string; snapshot_date?: string } = {}
  try {
    body = await req.json()
  } catch {
    // Body optionnel
  }

  const snapshotDate = body.snapshot_date ?? new Date().toISOString().split('T')[0]

  // Résoudre les organisations à traiter
  let orgQuery = supabase
    .from('organizations')
    .select('id')
    .eq('is_active', true)

  if (body.organization_id) {
    orgQuery = orgQuery.eq('id', body.organization_id)
  }

  const { data: orgs, error: orgError } = await orgQuery
  if (orgError || !orgs?.length) {
    return errorResponse('No active organizations found', 404)
  }

  // Acquire cron lock to prevent concurrent scoring runs
  const lockAcquired = await acquireCronLock(supabase, 'calculate-scores', 300)
  if (!lockAcquired) {
    return errorResponse('Scoring already in progress', 409)
  }

  const results: Array<{ organization_id: string; accounts_scored: number; segments_assigned: number; errors: number }> = []

  try {
    for (const org of orgs) {
      const organizationId = org.id
      let accountsScored = 0
      let segmentsAssigned = 0
      let errors = 0

      const logger = new DataSyncLogger({
        supabase,
        organizationId,
        syncSource: 'scoring',
        syncType: 'daily',
        triggeredBy: 'cron',
      })
      await logger.start()

      try {
        // Poids de scoring de l'org (S11) — fallback défaut produit si absent/non validé.
        // (Le modèle v3 n'a plus besoin du MRR max de l'org : aucune des 3
        // dimensions payment_health/revenue_dynamics/contract_renewal ne
        // normalise par rapport au plus gros compte du portefeuille.)
        const { data: orgWeightsRow } = await supabase
          .from('organizations')
          .select('scoring_weights')
          .eq('id', organizationId)
          .maybeSingle()

        const rawWeights = orgWeightsRow?.scoring_weights as ScoringWeights | undefined
        const scoringWeights: ScoringWeights = rawWeights && validateScoringWeights(rawWeights)
          ? rawWeights
          : DEFAULT_SCORING_WEIGHTS

        // Mapping seat_limit par stripe_price_id (S6) — fetch unique par org.
        const { data: mappingRows } = await supabase
          .from('stripe_product_mappings')
          .select('stripe_price_id, seat_limit, unlimited_seats')
          .eq('organization_id', organizationId)

        const mappingsByPriceId = new Map<string, SeatMapping>()
        for (const row of (mappingRows ?? [])) {
          mappingsByPriceId.set(row.stripe_price_id, { seat_limit: row.seat_limit, unlimited_seats: row.unlimited_seats })
        }

        // Scorer les accounts par batch paginé (évite OOM et timeout N+1)
        const accountScores = new Map<string, ScoreResult>()
        const accountSegmentInputs = new Map<string, SegmentInputV3>()
        const allAccounts: AccountWithCreatedAt[] = []
        const dispatchQueue: DispatchTask[] = []
        let batchOffset = 0
        let batchFailed = false
        let batchCount = 0

        while (batchCount < MAX_BATCHES) {
          batchCount++
          const { data: batch, error: batchError } = await supabase
            .from('accounts')
            .select('id, organization_id, mrr_cents, seat_count, seat_limit, contract_end_date, contract_start_date, billing_interval, health_score, churn_risk_score, expansion_score, churn_risk_band, health_score_status, stripe_customer_id, created_at')
            .eq('organization_id', organizationId)
            .range(batchOffset, batchOffset + SCORING_BATCH_SIZE - 1)

          if (batchError) {
            console.error(JSON.stringify({
              level: 'error',
              function_name: 'calculate-scores',
              organization_id: organizationId,
              message: `accounts query failed at offset ${batchOffset}: ${batchError.message}`,
            }))
            if (batchOffset === 0) {
              await logger.fail(batchError.message)
              batchFailed = true
            }
            break
          }

          if (!batch?.length) break

          allAccounts.push(...(batch as AccountWithCreatedAt[]))

          // Pre-fetch all scoring data in parallel bulk queries (instead of N+1)
          const batchIds = batch.map((a: { id: string }) => a.id)
          const { invoices90dMap, invoices12moMap, movements6moMap, subscriptionsMap, mrr3moAgoMap, healthScore30dAgoMap, overdueCountMap, overdueAmountMap } =
            await prefetchScoringData(supabase, batchIds)

          // Score each account (pure — no DB calls)
          const historyRows: Array<Record<string, unknown>> = []

          for (const account of batch as AccountWithCreatedAt[]) {
            try {
              const invoices90d = invoices90dMap.get(account.id) ?? []
              const invoices12mo = invoices12moMap.get(account.id) ?? []
              const movements6mo = movements6moMap.get(account.id) ?? []
              const subscriptions = subscriptionsMap.get(account.id) ?? []
              const mrr3moAgoCents = mrr3moAgoMap.get(account.id) ?? null
              const healthScore30dAgo = healthScore30dAgoMap.get(account.id) ?? null

              const activePriceId = subscriptions.find((s) => s.status === 'active' || s.status === 'past_due')?.stripe_price_id ?? null
              const { seatUsagePct, reason: seatUsageUnavailableReason } = computeSeatUsagePct(account.seat_count, activePriceId, mappingsByPriceId)

              const { scores, expansionSignals, hasOverdueInvoices, subscriptionCanceled } = scoreAccountPure({
                account,
                invoices90d,
                invoices12mo,
                movements6mo,
                mrr3moAgoCents,
                healthScore30dAgo,
                subscriptions,
                seatUsagePct,
                seatUsageUnavailableReason: seatUsageUnavailableReason ?? 'seat_data_not_configured',
                weights: scoringWeights,
              })

              accountScores.set(account.id, scores)

              const hasExpansionSignal = expansionSignals.has_upgrade_event || expansionSignals.has_expansion_mrr_event || expansionSignals.invoice_growth_detected
              const segInput: SegmentInputV3 = {
                healthScoreStatus: scores.health_score_status,
                healthScoreBand: scores.health_score_band,
                churnRiskBand: scores.churn_risk_band,
                hasExpansionSignal,
                mrrCents: account.mrr_cents ?? 0,
                hasOverdueInvoices,
                subscriptionCanceled,
                accountCreatedAt: account.created_at,
              }
              accountSegmentInputs.set(account.id, segInput)

              // Narratives déterministes (EN) — persistées pour accès direct du frontend.
              // usage_narrative/engagement_narrative ne sont plus régénérées (dimensions
              // retirées du modèle v3) — omises de l'update ci-dessous, restent figées.
              const overdueCount = overdueCountMap.get(account.id) ?? 0
              const narratives = generateNarrativesV3({
                health_score_points: scores.health_score,
                health_score_status: scores.health_score_status,
                payment_health_score: scores.payment_health_score,
                revenue_dynamics_score: scores.revenue_dynamics_score,
                contract_renewal_score: scores.contract_renewal_score,
                mrr_cents: account.mrr_cents ?? 0,
                overdue_count: overdueCount,
                overdue_amount_cents: overdueAmountMap.get(account.id) ?? 0,
                contract_end_date: account.contract_end_date ?? null,
                billing_interval: account.billing_interval ?? null,
              })

              historyRows.push({
                organization_id: organizationId,
                account_id: account.id,
                snapshot_date: snapshotDate,
                health_score: scores.health_score,
                health_score_status: scores.health_score_status,
                health_score_max_points: scores.health_score_max_points,
                health_score_band: scores.health_score_band,
                churn_risk_score: scores.churn_risk_score,
                churn_risk_band: scores.churn_risk_band,
                risk_signals_triggered: scores.risk_signals_triggered,
                risk_signals_evaluated: scores.risk_signals_evaluated,
                expansion_score: scores.expansion_score,
                expansion_score_status: scores.expansion_score_status,
                expansion_unavailable_reason: scores.expansion_unavailable_reason,
                payment_health_score: scores.payment_health_score,
                revenue_dynamics_score: scores.revenue_dynamics_score,
                contract_renewal_score: scores.contract_renewal_score,
                score_breakdown: scores.score_breakdown,
                trend_30d: scores.trend_30d,
                mrr_cents: account.mrr_cents ?? 0,
                model_version: MODEL_VERSION,
                inputs_used: {
                  mrr_cents: account.mrr_cents ?? 0,
                  mrr_3mo_ago_cents: mrr3moAgoCents,
                  overdue_count: overdueCount,
                  invoices_90d: invoices90d.length,
                  invoices_12mo: invoices12mo.length,
                  movements_6mo: movements6mo.length,
                  billing_interval: account.billing_interval ?? null,
                  contract_end_date: account.contract_end_date ?? null,
                  contract_start_date: account.contract_start_date ?? null,
                  seat_usage_pct: seatUsagePct,
                },
              })

              // Update account current scores + narratives (usage_narrative/
              // engagement_narrative volontairement omis — dimensions retirées).
              const { error: updateError } = await supabase
                .from('accounts')
                .update({
                  health_score: scores.health_score,
                  health_score_status: scores.health_score_status,
                  health_score_max_points: scores.health_score_max_points,
                  health_score_band: scores.health_score_band,
                  churn_risk_score: scores.churn_risk_score,
                  churn_risk_band: scores.churn_risk_band,
                  risk_signals_triggered: scores.risk_signals_triggered,
                  risk_signals_evaluated: scores.risk_signals_evaluated,
                  expansion_score: scores.expansion_score,
                  expansion_score_status: scores.expansion_score_status,
                  expansion_unavailable_reason: scores.expansion_unavailable_reason,
                  payment_health_score: scores.payment_health_score,
                  revenue_dynamics_score: scores.revenue_dynamics_score,
                  contract_renewal_score: scores.contract_renewal_score,
                  score_breakdown: scores.score_breakdown,
                  trend_30d: scores.trend_30d,
                  health_narrative: narratives.health_narrative,
                  financial_narrative: narratives.financial_narrative,
                  contract_narrative: narratives.contract_narrative,
                  scores_calculated_at: new Date().toISOString(),
                })
                .eq('id', account.id)

              if (updateError) {
                console.error(JSON.stringify({
                  level: 'error',
                  function_name: 'calculate-scores',
                  organization_id: organizationId,
                  account_id: account.id,
                  message: `accounts update failed: ${updateError.message}`,
                }))
                errors++
                logger.increment('records_failed')
                continue
              }

              accountsScored++
              logger.increment('records_processed')

              // Détecter changement de segment ou seuil churn (pour dispatch outbound).
              // Ancien état = dernier churn_risk_band/health_score_status persistés sur
              // le compte (pas de défaut ?? 50 — un compte jamais scoré part du sentinel
              // 'jamais_score', ce qui déclenche naturellement le dispatch au premier run).
              const oldSegment = getPreviousPrimarySegment(account)
              const newSegTypes = determineSegmentTypesV3(segInput)
              const newSegment = getPrimarySegment(newSegTypes)

              // churn_risk_band (pas un seuil numérique hardcodé) : sous le
              // modèle additif v3, churn_risk_score n'a plus la même
              // distribution que l'ancien "100-health+additifs" — un seuil
              // magique comme ">= 60" hérité du V1 serait mal calibré ici.
              if (oldSegment !== newSegment || scores.churn_risk_band === 'high') {
                dispatchQueue.push({ account, scores, oldSegment, newSegment, hasOverdue: hasOverdueInvoices })
              }
            } catch (err) {
              console.error(JSON.stringify({
                level: 'error',
                function_name: 'calculate-scores',
                organization_id: organizationId,
                account_id: (account as { id: string }).id,
                message: err instanceof Error ? err.message : String(err),
              }))
              errors++
              logger.increment('records_failed')
            }
          }

          // Batch upsert score_history for this batch
          if (historyRows.length > 0) {
            const { error: historyError } = await supabase
              .from('score_history')
              .upsert(historyRows, { onConflict: 'organization_id,account_id,snapshot_date', ignoreDuplicates: false })

            if (historyError) {
              console.error(JSON.stringify({
                level: 'error',
                function_name: 'calculate-scores',
                organization_id: organizationId,
                message: `score_history batch upsert failed: ${historyError.message}`,
              }))
            }
          }

          // If batch was smaller than page size, we've reached the end
          if (batch.length < SCORING_BATCH_SIZE) break
          batchOffset += batch.length
        }

        if (batchFailed) continue

        if (allAccounts.length === 0) {
          await logger.complete({ accounts_scored: 0, segments_assigned: 0 })
          continue
        }

        // ── Outbound webhook dispatch + Playbook executor (fire-and-forget) ──
        if (dispatchQueue.length > 0) {
          const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
          const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

          Promise.allSettled(
            dispatchQueue.map(({ account, scores, oldSegment, newSegment }) => {
              const eventType = oldSegment !== newSegment ? 'segment_change' : 'churn_threshold'
              const commonBody = {
                organization_id: organizationId,
                account_id: account.id,
                stripe_customer_id: account.stripe_customer_id ?? '',
                segment_previous: oldSegment,
                segment_current: newSegment,
                health_score: scores.health_score,
                churn_risk_score: scores.churn_risk_score,
                expansion_score: scores.expansion_score,
                mrr_cents: account.mrr_cents ?? 0,
              }
              const headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseKey}`,
              }
              // Dispatch outbound webhook (JSON générique)
              const outboundP = fetch(`${supabaseUrl}/functions/v1/outbound-webhook-dispatch`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ ...commonBody, event_type: eventType }),
              }).catch((err) => {
                console.error(JSON.stringify({
                  level: 'warn',
                  function_name: 'calculate-scores',
                  organization_id: organizationId,
                  message: `outbound dispatch fire-and-forget failed: ${err instanceof Error ? err.message : String(err)}`,
                }))
              })
              // Dispatch playbook executor (connecteurs email/slack/etc.)
              const playbookP = fetch(`${supabaseUrl}/functions/v1/playbook-executor`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ ...commonBody, trigger_reason: eventType }),
              }).catch((err) => {
                console.error(JSON.stringify({
                  level: 'warn',
                  function_name: 'calculate-scores',
                  organization_id: organizationId,
                  message: `playbook-executor fire-and-forget failed: ${err instanceof Error ? err.message : String(err)}`,
                }))
              })
              return Promise.all([outboundP, playbookP])
            }),
          ).catch(() => {})
        }

        // ── Segment Assignment ──────────────────────────────
        try {
          const segResult = await assignSegments(
            supabase,
            organizationId,
            allAccounts,
            accountScores,
            accountSegmentInputs,
          )
          segmentsAssigned = segResult.segmentsAssigned
        } catch (err) {
          console.error(JSON.stringify({
            level: 'error',
            function_name: 'calculate-scores',
            organization_id: organizationId,
            message: `segment assignment failed: ${err instanceof Error ? err.message : String(err)}`,
          }))
        }

        // Marquer le premier scoring réussi pour l'onboarding (idempotent)
        if (accountsScored > 0) {
          await supabase
            .from('organizations')
            .update({ first_score_calculated_at: new Date().toISOString() })
            .eq('id', organizationId)
            .is('first_score_calculated_at', null)
        }

        // Déclencher generate-insights après le scoring (EdgeRuntime.waitUntil garantit l'exécution)
        if (accountsScored > 0) {
          const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
          const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
          const insightPromise = fetch(`${supabaseUrl}/functions/v1/generate-insights`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseKey}`,
            },
            body: JSON.stringify({ organization_id: organizationId }),
          }).catch((err) => {
            console.error(JSON.stringify({
              level: 'warn',
              function_name: 'calculate-scores',
              organization_id: organizationId,
              message: `generate-insights trigger failed: ${err instanceof Error ? err.message : String(err)}`,
            }))
          })
          EdgeRuntime.waitUntil(insightPromise)
        }

        await logger.complete({ accounts_scored: accountsScored, segments_assigned: segmentsAssigned, errors })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await logger.fail(msg)
        errors++
      }

      results.push({ organization_id: organizationId, accounts_scored: accountsScored, segments_assigned: segmentsAssigned, errors })
    }

    return jsonResponse({
      success: true,
      snapshot_date: snapshotDate,
      organizations_processed: orgs.length,
      results,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'calculate-scores',
      message: msg,
    }))

    await alertSlack(
      `calculate-scores failed: ${msg}`,
      { level: 'critical' },
    )

    return errorResponse(`Scoring failed: ${msg}`, 500)
  } finally {
    await releaseCronLock(supabase, 'calculate-scores')
  }
})
