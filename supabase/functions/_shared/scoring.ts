// ── Types ────────────────────────────────────────────────────
export interface Account {
  id: string
  organization_id: string
  mrr_cents: number | null
  seat_count: number | null
  seat_limit: number | null
  contract_end_date: string | null
  health_score: number | null
  churn_risk_score: number | null
}

export interface UsageStats {
  login_count: number
  feature_count: number
  total_events: number
  distinct_features: number
  days_active: number
}

export interface HubspotData {
  nps_score: number | null
  open_ticket_count: number | null
  open_deal_count: number | null
  last_meeting_date: string | null
}

export interface InvoiceStatus {
  has_overdue: boolean
  overdue_count: number
}

export interface SubscriptionStatus {
  hasAny: boolean
}

export interface SignalsAvailable {
  financial: boolean
  engagement: boolean
  contract: boolean
  product_usage: boolean
}

// ── Calcul Usage Score (35%) ──────────────────────────────────
export function calcUsageScore(stats: UsageStats): number {
  if (stats.total_events === 0) return 50  // Neutre quand pas de données (cohérent avec engagement/contrat)

  const activityScore = Math.min(100, (stats.days_active / 30) * 100)
  const featureScore = Math.min(100, (stats.distinct_features / 10) * 100)
  const volumeScore = Math.min(100, (Math.log10(Math.max(1, stats.total_events)) / 3) * 100)

  return Math.round((activityScore * 0.4 + featureScore * 0.3 + volumeScore * 0.3) * 100) / 100
}

// ── Calcul Financial Score (25%) ──────────────────────────────
// v2-explicit-no-data : un compte n'ayant JAMAIS eu de subscription Stripe
// (subscriptionStatus.hasAny=false) est un signal manquant (neutre, 50),
// pas un risque financier. Un compte ayant déjà eu une subscription mais
// dont le mrr_cents actuel est 0 (canceled/past_due) reste un vrai churn (0)
// — comportement inchangé, comme le cas overdue_count>=5 (retombe dans le
// calcul normal ci-dessous, penaltyFactor tombe à 0 exactement à ce seuil).
export function calcFinancialScore(
  mrrCents: number | null,
  invoiceStatus: InvoiceStatus,
  maxMrr: number,
  subscriptionStatus: SubscriptionStatus,
): number {
  if (!subscriptionStatus.hasAny) return 50
  if (!mrrCents || mrrCents <= 0) return 0

  const mrrScore = maxMrr > 0 ? Math.min(100, (mrrCents / maxMrr) * 100) : 50

  const penaltyFactor = invoiceStatus.has_overdue
    ? Math.max(0, 1 - invoiceStatus.overdue_count * 0.2)
    : 1

  return Math.round(mrrScore * penaltyFactor * 100) / 100
}

// ── Calcul Engagement Score (20%) ─────────────────────────────
// V1 : basé sur tickets + meetings (NPS prévu en V2)
export function calcEngagementScore(hubspot: HubspotData | null): number {
  if (!hubspot) return 50

  let score = 50

  // Tickets support : 0 = bon signe, 3+ = alerte (±25 pts)
  if (hubspot.open_ticket_count !== null) {
    if (hubspot.open_ticket_count === 0) score += 15
    else if (hubspot.open_ticket_count <= 2) score -= 5
    else if (hubspot.open_ticket_count >= 3) score -= 25
  }

  // Dernière réunion : récente = engagé, ancienne = désengagé (±25 pts)
  if (hubspot.last_meeting_date) {
    const daysSince = Math.floor(
      (Date.now() - new Date(hubspot.last_meeting_date).getTime()) / 86400000,
    )
    if (daysSince < 30) score += 25
    else if (daysSince < 60) score += 10
    else if (daysSince > 90) score -= 15
    else if (daysSince > 180) score -= 25
  }

  return Math.round(Math.max(0, Math.min(100, score)) * 100) / 100
}

// ── Calcul Contract Score (20%) ───────────────────────────────
export function calcContractScore(account: Account): number {
  if (!account.contract_end_date) return 50

  const daysUntilRenewal = Math.floor(
    (new Date(account.contract_end_date).getTime() - Date.now()) / 86400000,
  )

  if (daysUntilRenewal < 0) return 10
  if (daysUntilRenewal <= 30) return 25
  if (daysUntilRenewal <= 60) return 50
  if (daysUntilRenewal <= 90) return 75
  return 100
}

// ── Calcul Expansion Score ────────────────────────────────────
// Mode ratio   (seat_limit connu)  : (seat_usage_pct×60%) + (feature_ceiling×40%)
// Mode absolu  (seat_limit absent) : (seat_count_signal×80%) + (feature_ceiling×20%)
//   → seat_count_signal = min(100, seat_count / 15 × 100)
//     15 sièges = signal 100 (seuil empirique équipes mid-market)
//   → poids 80/20 pour compenser l'absence du ratio d'occupation
export function calcExpansionScore(account: Account, stats: UsageStats): number {
  const featureCeilingScore = Math.min(100, (stats.distinct_features / 10) * 100)

  if (account.seat_count !== null && account.seat_limit !== null && account.seat_limit > 0) {
    // Mode ratio : on connaît le plafond contractuel
    const seatUsagePct = Math.min(100, (account.seat_count / account.seat_limit) * 100)
    return Math.round((seatUsagePct * 0.6 + featureCeilingScore * 0.4) * 100) / 100
  }

  if (account.seat_count !== null && account.seat_count > 0) {
    // Mode absolu : pas de plafond connu, signal basé sur la taille absolue de l'équipe
    const seatSignal = Math.min(100, (account.seat_count / 15) * 100)
    return Math.round((seatSignal * 0.8 + featureCeilingScore * 0.2) * 100) / 100
  }

  // Pas de données sièges ni usage
  return Math.round(featureCeilingScore * 0.4 * 100) / 100
}

// ── Segmentation ─────────────────────────────────────────────
export type SegmentType =
  | 'champions' | 'en_expansion' | 'stables' | 'a_risque_leger'
  | 'en_danger_critique' | 'impayes' | 'en_churn' | 'nouveaux'
  | 'donnees_insuffisantes'

export const SYSTEM_SEGMENT_TYPES: SegmentType[] = [
  'champions', 'en_expansion', 'stables', 'a_risque_leger',
  'en_danger_critique', 'impayes', 'en_churn', 'nouveaux',
  'donnees_insuffisantes',
]

// ════════════════════════════════════════════════════════════
// SCORING ENGINE V2 (produit) — model_version 'v3' en base
// ════════════════════════════════════════════════════════════
//
// Principe fondateur (S1) : « no data ≠ neutral data ». Aucune fonction
// ci-dessous ne retourne un défaut numérique (50, 0, ...) pour signaler une
// donnée absente — l'absence est portée par `null` / `status: 'unavailable'`
// et exclue explicitement des moyennes pondérées.
//
// 3 dimensions Stripe-only (somme des poids = 100, poids configurables par
// org via organizations.scoring_weights, S11) :
//   payment_health     (35) — statut factures, historique paiement, dunning
//   revenue_dynamics   (35) — tendance MRR, contraction, expansion
//   contract_renewal   (30) — intervalle facturation, proximité renouv., tenure
//
// `engagement` (HubSpot) et `product_usage` sont des dimensions du futur
// modèle v3-produit (nom de code différent du model_version 'v3' DB — voir
// commentaire migration) : elles n'existent pas dans ce calcul. Zéro score,
// zéro défaut pour ces deux axes.

// ── Signal pondéré interne à une dimension ────────────────────
export interface WeightedSignal {
  code: string // identifiant stable (ex. 'invoice_status_score') — base du score_breakdown (S8)
  label: string // libellé lisible pour l'explicabilité
  weight: number // poids interne (fraction de 1.0 à l'intérieur de la dimension)
  value: number | null // null = signal non disponible
}

export interface SignalBreakdown {
  code: string
  label: string
  weight: number
  value: number | null
  status: 'available' | 'unavailable'
}

export interface DimensionOutcome {
  score: number | null
  status: 'available' | 'unavailable'
  // Détail par signal — base de score_breakdown (S8) et de l'explicabilité
  // frontend/langage naturel. Toujours présent, y compris pour les signaux
  // `unavailable` (value: null) : c'est ce qui rend visible QUEL signal
  // manque, pas seulement que la dimension est incomplète.
  signals: SignalBreakdown[]
}

// Moyenne pondérée des signaux disponibles d'une dimension. Si moins de 50%
// du poids interne est disponible, la dimension entière est `unavailable`
// (S3). Cette renormalisation est INTRA-dimension uniquement — elle ne
// contredit pas la décision "pas de renormalisation dynamique" du composite
// Health Score, qui porte sur les poids ENTRE dimensions (S4).
export function combineWeightedSignals(signals: WeightedSignal[]): DimensionOutcome {
  const signalBreakdown: SignalBreakdown[] = signals.map((s) => ({
    code: s.code,
    label: s.label,
    weight: s.weight,
    value: s.value,
    status: s.value !== null ? 'available' : 'unavailable',
  }))

  const available = signals.filter((s) => s.value !== null)
  const availableWeight = available.reduce((sum, s) => sum + s.weight, 0)

  if (availableWeight < 0.5) return { score: null, status: 'unavailable', signals: signalBreakdown }

  const weightedSum = available.reduce((sum, s) => sum + s.weight * (s.value as number), 0)
  return {
    score: Math.round((weightedSum / availableWeight) * 100) / 100,
    status: 'available',
    signals: signalBreakdown,
  }
}

// ── payment_health (poids org, défaut 35) ─────────────────────
export interface InvoiceRecord {
  status: string // draft | open | paid | void | uncollectible
  due_date: string | null
  paid_at: string | null
  invoice_date: string
}

export interface PaymentHealthInput {
  invoices90d: InvoiceRecord[] // invoice_date dans les 90 derniers jours
  invoices12mo: InvoiceRecord[] // invoice_date dans les 12 derniers mois
}

function daysOverdue(inv: InvoiceRecord, now: number): number {
  if (!inv.due_date) return 0
  if (inv.status !== 'open' && inv.status !== 'uncollectible') return 0
  const due = new Date(inv.due_date).getTime()
  return Math.max(0, Math.floor((now - due) / 86400000))
}

// invoice_status_score (poids interne 0.40) : dernier statut factures 90j.
// unavailable si aucune facture émise sur la période (rien à juger).
function calcInvoiceStatusScore(invoices90d: InvoiceRecord[], now: number): number | null {
  if (invoices90d.length === 0) return null
  if (invoices90d.some((i) => i.status === 'uncollectible')) return 0
  if (invoices90d.some((i) => daysOverdue(i, now) >= 15)) return 10
  if (invoices90d.some((i) => daysOverdue(i, now) > 0)) return 40
  return 100
}

// payment_history_score (poids interne 0.35) : % factures payées à temps
// sur 12 mois. unavailable si < 3 factures sur la période (échantillon trop
// petit pour être un signal fiable).
function calcPaymentHistoryScore(invoices12mo: InvoiceRecord[]): number | null {
  if (invoices12mo.length < 3) return null
  const onTime = invoices12mo.filter((i) => {
    if (i.status !== 'paid' || !i.paid_at) return false
    if (!i.due_date) return true
    return new Date(i.paid_at).getTime() <= new Date(i.due_date).getTime()
  }).length
  return Math.round((onTime / invoices12mo.length) * 100 * 100) / 100
}

// dunning_score (poids interne 0.25) : échecs de paiement sur 90j.
// Le schéma actuel (Stripe-only, pas de table dunning/payment_attempts)
// n'expose pas d'historique de tentatives échouées — on l'approxime à
// partir des factures : `uncollectible` = échec non récupéré ; `paid` avec
// paid_at > due_date + 5j = échec probable récupéré après relance. Documenté
// comme approximation, pas une vérité Stripe brute — à remplacer si un jour
// une table dunning existe (hors scope V1).
// unavailable si aucune facture émise sur 90j (même raison que invoice_status_score).
// Exporté : réutilisé tel quel par le signal de risque churn "2 échecs de
// paiement sur 90j" (S5) pour ne pas dupliquer l'approximation dunning.
export function countPaymentFailures90d(invoices90d: InvoiceRecord[]): { total: number; unrecovered: number } {
  const unrecovered = invoices90d.filter((i) => i.status === 'uncollectible').length
  const recoveredLate = invoices90d.filter((i) => {
    if (i.status !== 'paid' || !i.paid_at || !i.due_date) return false
    const lateDays = (new Date(i.paid_at).getTime() - new Date(i.due_date).getTime()) / 86400000
    return lateDays > 5
  }).length
  return { total: unrecovered + recoveredLate, unrecovered }
}

function calcDunningScore(invoices90d: InvoiceRecord[]): number | null {
  if (invoices90d.length === 0) return null
  const { total, unrecovered } = countPaymentFailures90d(invoices90d)

  if (total === 0) return 100
  if (total === 1 && unrecovered === 0) return 60
  return 20
}

export function calcPaymentHealthDimension(input: PaymentHealthInput, now: number = Date.now()): DimensionOutcome {
  return combineWeightedSignals([
    { code: 'invoice_status_score', label: 'Invoice status (90d)', weight: 0.40, value: calcInvoiceStatusScore(input.invoices90d, now) },
    { code: 'payment_history_score', label: 'On-time payment history (12 months)', weight: 0.35, value: calcPaymentHistoryScore(input.invoices12mo) },
    { code: 'dunning_score', label: 'Payment failures / dunning (90d)', weight: 0.25, value: calcDunningScore(input.invoices90d) },
  ])
}

// ── revenue_dynamics (poids org, défaut 35) ───────────────────
export interface MrrMovementRecord {
  movement_type: 'new' | 'expansion' | 'contraction' | 'churn' | 'reactivation'
  amount_cents: number
  movement_date: string
}

export interface RevenueDynamicsInput {
  mrrCurrentCents: number
  mrr3moAgoCents: number | null // null si < 3 mois d'historique
  movements6mo: MrrMovementRecord[]
}

// mrr_trend_score (poids interne 0.45) : mapping linéaire -20%→0, 0%→60, +10%→100.
function calcMrrTrendScore(mrrCurrentCents: number, mrr3moAgoCents: number | null): number | null {
  if (mrr3moAgoCents === null || mrr3moAgoCents <= 0) return null
  const trend = (mrrCurrentCents - mrr3moAgoCents) / mrr3moAgoCents

  let score: number
  if (trend <= -0.20) score = 0
  else if (trend <= 0) score = 60 * ((trend + 0.20) / 0.20)
  else if (trend <= 0.10) score = 60 + 40 * (trend / 0.10)
  else score = 100

  return Math.round(Math.max(0, Math.min(100, score)) * 100) / 100
}

// contraction_score (poids interne 0.35) : contraction MRR sur 6 mois vs MRR courant.
function calcContractionScore(mrrCurrentCents: number, movements6mo: MrrMovementRecord[]): number {
  const contractionTotal = movements6mo
    .filter((m) => m.movement_type === 'contraction')
    .reduce((sum, m) => sum + Math.abs(m.amount_cents), 0)

  if (contractionTotal === 0) return 100
  if (mrrCurrentCents <= 0) return 0
  const contractionPct = contractionTotal / mrrCurrentCents
  if (contractionPct < 0.10) return 50
  return 0
}

// expansion_signal_score (poids interne 0.20) : absence d'expansion n'est
// pas un signal négatif fort (60, pas 0).
function calcExpansionSignalScore(movements6mo: MrrMovementRecord[]): number {
  return movements6mo.some((m) => m.movement_type === 'expansion') ? 100 : 60
}

export function calcRevenueDynamicsDimension(input: RevenueDynamicsInput): DimensionOutcome {
  return combineWeightedSignals([
    { code: 'mrr_trend_score', label: 'MRR trend (3 months)', weight: 0.45, value: calcMrrTrendScore(input.mrrCurrentCents, input.mrr3moAgoCents) },
    { code: 'contraction_score', label: 'MRR contraction (6 months)', weight: 0.35, value: calcContractionScore(input.mrrCurrentCents, input.movements6mo) },
    { code: 'expansion_signal_score', label: 'Expansion signal (6 months)', weight: 0.20, value: calcExpansionSignalScore(input.movements6mo) },
  ])
}

// ── contract_renewal (poids org, défaut 30) ───────────────────
export interface ContractRenewalInput {
  billingInterval: 'monthly' | 'annual' | null
  contractEndDate: string | null
  contractStartDate: string | null
}

// billing_interval_score (poids interne 0.30) : le mensuel churn structurellement
// plus (friction de sortie nulle).
function calcBillingIntervalScore(billingInterval: 'monthly' | 'annual' | null): number | null {
  if (billingInterval === null) return null
  return billingInterval === 'annual' ? 100 : 55
}

// renewal_proximity_score (poids interne 0.40).
function calcRenewalProximityScore(
  billingInterval: 'monthly' | 'annual' | null,
  contractEndDate: string | null,
  now: number,
): number | null {
  if (billingInterval === 'monthly') return 70 // constante : la proximité n'a pas de sens, déjà scoré via l'intervalle
  if (billingInterval === 'annual') {
    if (!contractEndDate) return null
    const daysUntil = Math.floor((new Date(contractEndDate).getTime() - now) / 86400000)
    if (daysUntil > 90) return 100
    if (daysUntil >= 31) return 70
    return 40
  }
  return null // billing_interval inconnu
}

// tenure_score (poids interne 0.30).
function calcTenureScore(contractStartDate: string | null, now: number): number | null {
  if (!contractStartDate) return null
  const monthsSince = (now - new Date(contractStartDate).getTime()) / (30 * 86400000)
  if (monthsSince < 3) return 40
  if (monthsSince < 12) return 65
  if (monthsSince < 24) return 85
  return 100
}

export function calcContractRenewalDimension(input: ContractRenewalInput, now: number = Date.now()): DimensionOutcome {
  return combineWeightedSignals([
    { code: 'billing_interval_score', label: 'Billing interval', weight: 0.30, value: calcBillingIntervalScore(input.billingInterval) },
    { code: 'renewal_proximity_score', label: 'Renewal proximity', weight: 0.40, value: calcRenewalProximityScore(input.billingInterval, input.contractEndDate, now) },
    { code: 'tenure_score', label: 'Contract tenure', weight: 0.30, value: calcTenureScore(input.contractStartDate, now) },
  ])
}

// ── Health Score composite v3 — SANS renormalisation dynamique (S4) ───
// Les poids entre dimensions ne bougent JAMAIS. Une dimension indisponible
// réduit le dénominateur (health_score_max_points), jamais les poids des
// dimensions restantes.
export interface ScoringWeights {
  payment_health: number
  revenue_dynamics: number
  contract_renewal: number
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  payment_health: 35,
  revenue_dynamics: 35,
  contract_renewal: 30,
}

export interface HealthScoreV3Result {
  health_score_points: number | null // null si status='insufficient'
  health_score_max_points: number
  health_score_status: 'complete' | 'partial' | 'insufficient'
  health_score_band: 'healthy' | 'watch' | 'at_risk' | null
}

export function calcHealthScoreV3(
  dimensions: { paymentHealth: DimensionOutcome; revenueDynamics: DimensionOutcome; contractRenewal: DimensionOutcome },
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): HealthScoreV3Result {
  const entries: Array<{ outcome: DimensionOutcome; weight: number }> = [
    { outcome: dimensions.paymentHealth, weight: weights.payment_health },
    { outcome: dimensions.revenueDynamics, weight: weights.revenue_dynamics },
    { outcome: dimensions.contractRenewal, weight: weights.contract_renewal },
  ]

  const available = entries.filter((e) => e.outcome.status === 'available')
  const maxPoints = available.reduce((sum, e) => sum + e.weight, 0)
  const coveragePct = maxPoints // le total du modèle = 100

  let status: 'complete' | 'partial' | 'insufficient'
  if (coveragePct >= 100) status = 'complete'
  else if (coveragePct >= 50) status = 'partial'
  else status = 'insufficient'

  if (status === 'insufficient') {
    return { health_score_points: null, health_score_max_points: Math.round(maxPoints * 100) / 100, health_score_status: status, health_score_band: null }
  }

  const points = available.reduce((sum, e) => sum + (e.outcome.score as number) * (e.weight / 100), 0)
  const roundedPoints = Math.round(points * 100) / 100
  const pctOfMax = (roundedPoints / maxPoints) * 100

  let band: 'healthy' | 'watch' | 'at_risk'
  if (pctOfMax >= 70) band = 'healthy'
  else if (pctOfMax >= 40) band = 'watch'
  else band = 'at_risk'

  return {
    health_score_points: roundedPoints,
    health_score_max_points: Math.round(maxPoints * 100) / 100,
    health_score_status: status,
    health_score_band: band,
  }
}

export function validateScoringWeights(weights: ScoringWeights): boolean {
  const { payment_health, revenue_dynamics, contract_renewal } = weights
  const all = [payment_health, revenue_dynamics, contract_renewal]
  if (all.some((w) => w < 10 || w > 60)) return false
  return payment_health + revenue_dynamics + contract_renewal === 100
}

// ── score_breakdown (S8) — base de l'explicabilité ─────────────
// jsonb persisté tel quel dans accounts.score_breakdown / score_history.score_breakdown.
// Par dimension : score, statut, poids org, et le détail par signal contributeur
// (valeur brute + disponibilité). C'est ce jsonb qui alimentera la future
// explication en langage naturel (hors scope ici) — pas de format additionnel
// à inventer côté frontend.
export interface DimensionBreakdown {
  score: number | null
  status: 'available' | 'unavailable'
  weight: number
  signals: SignalBreakdown[]
}

export type ScoreBreakdown = {
  payment_health: DimensionBreakdown
  revenue_dynamics: DimensionBreakdown
  contract_renewal: DimensionBreakdown
}

export function buildScoreBreakdown(
  dimensions: { paymentHealth: DimensionOutcome; revenueDynamics: DimensionOutcome; contractRenewal: DimensionOutcome },
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): ScoreBreakdown {
  return {
    payment_health: { score: dimensions.paymentHealth.score, status: dimensions.paymentHealth.status, weight: weights.payment_health, signals: dimensions.paymentHealth.signals },
    revenue_dynamics: { score: dimensions.revenueDynamics.score, status: dimensions.revenueDynamics.status, weight: weights.revenue_dynamics, signals: dimensions.revenueDynamics.signals },
    contract_renewal: { score: dimensions.contractRenewal.score, status: dimensions.contractRenewal.status, weight: weights.contract_renewal, signals: dimensions.contractRenewal.signals },
  }
}

// ── trend_30d (S8) ───────────────────────────────────────────
// Calculé et PERSISTÉ au moment du scoring (pas à la lecture) — le pipeline
// dispose déjà du snapshot J-30 via score_history (même mécanisme que
// mrr3moAgoMap pour J-90 dans calculate-scores/index.ts), donc autant
// l'écrire une fois plutôt que de faire recalculer ce delta par chaque
// endpoint consommateur. 'flat' si health_score courant ou J-30 indisponible
// (statut insufficient d'un côté ou de l'autre) — cas volontairement couvert
// par le même comportement que "historique < 30j" prévu par la spec, pas un
// défaut caché : on ne sait juste pas si ça a bougé.
export function computeTrend30d(currentHealthScore: number | null, healthScore30dAgo: number | null): 'up' | 'flat' | 'down' {
  if (currentHealthScore === null || healthScore30dAgo === null) return 'flat'
  const delta = currentHealthScore - healthScore30dAgo
  if (delta >= 5) return 'up'
  if (delta <= -5) return 'down'
  return 'flat'
}

// ── Churn Risk Score v2 — additif, découplé du Health Score (S5) ──────
export type ChurnSignalSeverity = 'CRITIQUE' | 'MAJEUR' | 'MINEUR'

export interface ChurnSignalDefinition {
  code: string
  label: string
  severity: ChurnSignalSeverity
  points: number
  value: boolean | null // null = donnée absente, signal skippé (ni compté ni évalué)
}

export interface TriggeredSignal {
  code: string
  label: string
  severity: ChurnSignalSeverity
  points: number
}

export interface ChurnRiskV2Result {
  churn_risk_score: number
  churn_risk_band: 'low' | 'watch' | 'high'
  risk_signals_triggered: TriggeredSignal[]
  risk_signals_evaluated: number
}

// Interdiction absolue (S5) : pas de champ confidence/probability — les
// règles sont déterministes (Stripe), pas probabilistes. On expose
// risk_signals_evaluated ("basé sur N signaux") à la place d'un faux %.
export function calcChurnRiskV2(signals: ChurnSignalDefinition[]): ChurnRiskV2Result {
  const evaluable = signals.filter((s) => s.value !== null)
  const triggered = evaluable.filter((s) => s.value === true)

  const score = Math.max(0, Math.min(100, triggered.reduce((sum, s) => sum + s.points, 0)))

  let band: 'low' | 'watch' | 'high'
  if (score >= 50) band = 'high'
  else if (score >= 25) band = 'watch'
  else band = 'low'

  return {
    churn_risk_score: score,
    churn_risk_band: band,
    risk_signals_triggered: triggered.map(({ code, label, severity, points }) => ({ code, label, severity, points })),
    risk_signals_evaluated: evaluable.length,
  }
}

// Construit les 7 signaux de risque de la spec à partir de données pré-agrégées
// (skippe silencieusement — value: null — tout signal dont la donnée source
// est absente, plutôt que de le compter comme "non déclenché").
export interface ChurnSignalInputs {
  hasInvoiceOverdue15Plus: boolean | null
  contractionMrr20PctPlus3mo: boolean | null
  paymentFailures2PlusIn90d: boolean | null
  isMonthlyAndTenureUnder6mo: boolean | null
  annualRenewal30dPlusWithContraction6mo: boolean | null
  hasDowngrade6mo: boolean | null
  hasInvoiceOverdueUnder15: boolean | null
}

export function buildChurnSignals(inputs: ChurnSignalInputs): ChurnSignalDefinition[] {
  return [
    { code: 'invoice_overdue_15d', label: 'Invoice overdue for 15+ days', severity: 'CRITIQUE', points: 35, value: inputs.hasInvoiceOverdue15Plus },
    { code: 'mrr_contraction_20pct_3mo', label: 'MRR contraction of 20%+ over 3 months', severity: 'CRITIQUE', points: 30, value: inputs.contractionMrr20PctPlus3mo },
    { code: 'payment_failures_90d', label: '2 or more payment failures in the last 90 days', severity: 'MAJEUR', points: 25, value: inputs.paymentFailures2PlusIn90d },
    { code: 'monthly_young_account', label: 'Monthly billing and account under 6 months old', severity: 'MAJEUR', points: 20, value: inputs.isMonthlyAndTenureUnder6mo },
    { code: 'annual_renewal_soon_with_contraction', label: 'Annual renewal within 30 days with recent contraction', severity: 'MAJEUR', points: 20, value: inputs.annualRenewal30dPlusWithContraction6mo },
    { code: 'plan_downgrade_6mo', label: 'Plan downgrade within the last 6 months', severity: 'MINEUR', points: 10, value: inputs.hasDowngrade6mo },
    { code: 'invoice_overdue_under_15d', label: 'Invoice overdue for under 15 days', severity: 'MINEUR', points: 10, value: inputs.hasInvoiceOverdueUnder15 },
  ]
}

// ── Expansion Score v2 — jamais de cap silencieux (S6) ─────────────────
export interface ExpansionScoreV2Result {
  expansion_score: number | null
  expansion_score_status: 'available' | 'unavailable'
  expansion_unavailable_reason: string | null
}

// seatUsagePct doit être pré-calculé par l'appelant à partir de
// stripe_product_mappings (mapping seat_limit par plan) — null si l'org n'a
// pas configuré ce mapping pour le compte. `unavailableReason` permet à
// l'appelant de préciser la cause exacte (ex. 'unlimited_plan_no_ceiling'
// vs 'seat_data_not_configured') sans que cette fonction pure ait à
// recalculer le mapping elle-même.
export function calcExpansionScoreV2(seatUsagePct: number | null, unavailableReason: string = 'seat_data_not_configured'): ExpansionScoreV2Result {
  if (seatUsagePct === null) {
    return { expansion_score: null, expansion_score_status: 'unavailable', expansion_unavailable_reason: unavailableReason }
  }
  return {
    expansion_score: Math.round(Math.max(0, Math.min(100, seatUsagePct)) * 100) / 100,
    expansion_score_status: 'available',
    expansion_unavailable_reason: null,
  }
}

export interface ExpansionSignals {
  has_upgrade_event: boolean
  has_expansion_mrr_event: boolean
  invoice_growth_detected: boolean
}

// Toujours calculable depuis Stripe seul, indépendamment de expansion_score
// (S6) — même les comptes sans mapping sièges ont des signaux d'expansion.
export function calcExpansionSignals(
  movements6mo: MrrMovementRecord[],
  currentMrrCents: number,
  mrr3moAgoCents: number | null,
): ExpansionSignals {
  return {
    has_upgrade_event: movements6mo.some((m) => m.movement_type === 'expansion'),
    has_expansion_mrr_event: movements6mo.some((m) => m.movement_type === 'expansion' && m.amount_cents > 0),
    invoice_growth_detected: mrr3moAgoCents !== null && mrr3moAgoCents > 0 && currentMrrCents > mrr3moAgoCents,
  }
}

// ── Benchmarks — gate d'échantillon minimal (S7) ────────────────────────
export interface BenchmarkResult {
  value: number | null
  benchmark_status: 'ok' | 'insufficient_sample'
  benchmark_sample_size: number
}

// Toute statistique comparative interne (moyenne/médiane de segment,
// benchmark) DOIT passer par ce helper. En dessous de minN, la valeur est
// masquée plutôt que publiée avec une fausse autorité statistique.
export function gateBenchmark(sampleSize: number, computeValue: () => number, minN = 20): BenchmarkResult {
  if (sampleSize < minN) {
    return { value: null, benchmark_status: 'insufficient_sample', benchmark_sample_size: sampleSize }
  }
  return { value: computeValue(), benchmark_status: 'ok', benchmark_sample_size: sampleSize }
}

// ── Segmentation v3 (S12) ────────────────────────────────────────────
// 'en_expansion' est retiré des critères actifs (fusionné dans 'champions'
// qui exige désormais expansion_signals non vide) mais la valeur reste dans
// SYSTEM_SEGMENT_TYPES / le CHECK constraint DB pour compat descendante —
// aucune ligne n'y sera plus jamais assignée par cette fonction.
export type SegmentTypeV3 = Exclude<SegmentType, 'en_expansion'> | 'donnees_insuffisantes'

export interface SegmentInputV3 {
  healthScoreStatus: 'complete' | 'partial' | 'insufficient'
  healthScoreBand: 'healthy' | 'watch' | 'at_risk' | null
  churnRiskBand: 'low' | 'watch' | 'high'
  hasExpansionSignal: boolean
  mrrCents: number
  hasOverdueInvoices: boolean
  subscriptionCanceled: boolean
  accountCreatedAt: string
}

export function determineSegmentTypesV3(input: SegmentInputV3): SegmentTypeV3[] {
  const segments: SegmentTypeV3[] = []

  const daysSinceCreation = Math.floor((Date.now() - new Date(input.accountCreatedAt).getTime()) / 86400000)
  if (daysSinceCreation < 90) segments.push('nouveaux')

  if (input.mrrCents === 0 || input.subscriptionCanceled) {
    segments.push('en_churn')
  } else if (input.hasOverdueInvoices) {
    segments.push('impayes')
  } else if (input.healthScoreStatus === 'insufficient') {
    segments.push('donnees_insuffisantes')
  } else if (input.churnRiskBand === 'high') {
    segments.push('en_danger_critique')
  } else if (input.churnRiskBand === 'watch') {
    segments.push('a_risque_leger')
  } else if (input.healthScoreBand === 'healthy' && input.hasExpansionSignal) {
    segments.push('champions')
  } else {
    segments.push('stables')
  }

  return segments
}
