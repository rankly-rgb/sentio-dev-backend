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

// ── Health Score composite ────────────────────────────────────
export function calcHealthScore(
  usageScore: number,
  financialScore: number,
  engagementScore: number,
  contractScore: number,
): number {
  return Math.round(
    (usageScore * 0.35 + financialScore * 0.25 + engagementScore * 0.20 + contractScore * 0.20) * 100,
  ) / 100
}

// ── Indicateur de complétude des données ──────────────────────
// signals_available / data_completeness_pct : pas un calcul de score, juste
// un état des lieux "quels signaux étaient réellement disponibles pour ce
// run" — alimente le futur badge UI "Calculé sur X/4 signaux" (chantier 5.4).
export function computeSignalsAvailable(
  usage: UsageStats,
  hubspot: HubspotData | null,
  account: Account,
  subscriptionStatus: SubscriptionStatus,
): SignalsAvailable {
  return {
    financial: subscriptionStatus.hasAny,
    engagement: hubspot !== null,
    contract: account.contract_end_date !== null,
    product_usage: usage.total_events > 0,
  }
}

export function computeDataCompletenessPct(signals: SignalsAvailable): number {
  const values = Object.values(signals)
  const present = values.filter(Boolean).length
  return Math.round((present / values.length) * 1000) / 10
}

// ── Churn Risk Score ──────────────────────────────────────────
export function calcChurnRiskScore(
  healthScore: number,
  invoiceStatus: InvoiceStatus,
  daysActive: number,
  account: Account,
): number {
  let churnAdditif = 0
  if (invoiceStatus.has_overdue) churnAdditif += 20          // spec : past_due +20
  if (daysActive === 0) churnAdditif += 10                   // spec : last_login >45j +10 (aucune activité 30j = proxy)

  if (account.contract_end_date) {
    const daysUntilRenewal = Math.floor(
      (new Date(account.contract_end_date).getTime() - Date.now()) / 86400000,
    )
    if (daysUntilRenewal <= 30 && daysUntilRenewal >= 0) churnAdditif += 15  // spec : +15
    if (daysUntilRenewal < 0) churnAdditif += 25
  }

  return Math.max(0, Math.min(100, Math.round((100 - healthScore + churnAdditif) * 100) / 100))
}

// ── Segmentation ─────────────────────────────────────────────
export type SegmentType =
  | 'champions' | 'en_expansion' | 'stables' | 'a_risque_leger'
  | 'en_danger_critique' | 'impayes' | 'en_churn' | 'nouveaux'

export const SYSTEM_SEGMENT_TYPES: SegmentType[] = [
  'champions', 'en_expansion', 'stables', 'a_risque_leger',
  'en_danger_critique', 'impayes', 'en_churn', 'nouveaux',
]

/**
 * Determine which segment(s) an account belongs to.
 * Returns an array: score-based segment (mutually exclusive, first match)
 * + lifecycle segment ('nouveaux') which can overlap.
 */
export function determineSegmentTypes(
  scores: { health_score: number; churn_risk_score: number; expansion_score: number },
  mrrCents: number,
  hasOverdueInvoices: boolean,
  accountCreatedAt: string,
): SegmentType[] {
  const segments: SegmentType[] = []

  // Lifecycle: nouveaux if < 90 days old
  const daysSinceCreation = Math.floor(
    (Date.now() - new Date(accountCreatedAt).getTime()) / 86400000,
  )
  if (daysSinceCreation < 90) segments.push('nouveaux')

  // Score-based primary segment (mutually exclusive, priority order)
  if (mrrCents === 0) {
    segments.push('en_churn')
  } else if (hasOverdueInvoices) {
    segments.push('impayes')
  } else if (scores.churn_risk_score >= 70) {
    segments.push('en_danger_critique')
  } else if (scores.churn_risk_score >= 50) {
    segments.push('a_risque_leger')
  } else if (scores.health_score >= 80) {
    segments.push('champions')
  } else if (scores.expansion_score >= 70 && scores.health_score >= 60) {
    segments.push('en_expansion')
  } else {
    segments.push('stables')
  }

  return segments
}
