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

// ── Calcul Usage Score (35%) ──────────────────────────────────
export function calcUsageScore(stats: UsageStats): number {
  if (stats.total_events === 0) return 0

  const activityScore = Math.min(100, (stats.days_active / 30) * 100)
  const featureScore = Math.min(100, (stats.distinct_features / 10) * 100)
  const volumeScore = Math.min(100, (Math.log10(Math.max(1, stats.total_events)) / 3) * 100)

  return Math.round((activityScore * 0.4 + featureScore * 0.3 + volumeScore * 0.3) * 100) / 100
}

// ── Calcul Financial Score (25%) ──────────────────────────────
export function calcFinancialScore(
  mrrCents: number | null,
  invoiceStatus: InvoiceStatus,
  maxMrr: number,
): number {
  if (!mrrCents || mrrCents <= 0) return 0

  const mrrScore = maxMrr > 0 ? Math.min(100, (mrrCents / maxMrr) * 100) : 50

  const penaltyFactor = invoiceStatus.has_overdue
    ? Math.max(0, 1 - invoiceStatus.overdue_count * 0.2)
    : 1

  return Math.round(mrrScore * penaltyFactor * 100) / 100
}

// ── Calcul Engagement Score (20%) ─────────────────────────────
export function calcEngagementScore(hubspot: HubspotData | null): number {
  if (!hubspot) return 50

  let score = 50

  if (hubspot.nps_score !== null) {
    if (hubspot.nps_score >= 9) score += 30
    else if (hubspot.nps_score >= 7) score += 15
    else if (hubspot.nps_score >= 5) score += 0
    else score -= 20
  }

  if (hubspot.open_ticket_count !== null) {
    if (hubspot.open_ticket_count === 0) score += 10
    else if (hubspot.open_ticket_count >= 3) score -= 15
  }

  if (hubspot.last_meeting_date) {
    const daysSince = Math.floor(
      (Date.now() - new Date(hubspot.last_meeting_date).getTime()) / 86400000,
    )
    if (daysSince < 30) score += 10
    else if (daysSince > 90) score -= 10
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
export function calcExpansionScore(account: Account, stats: UsageStats): number {
  let seatUsagePct = 50
  if (account.seat_count !== null && account.seat_limit !== null && account.seat_limit > 0) {
    seatUsagePct = Math.min(100, (account.seat_count / account.seat_limit) * 100)
  }

  const featureCeilingScore = Math.min(100, (stats.distinct_features / 10) * 100)

  return Math.round(
    (seatUsagePct * 0.6 + featureCeilingScore * 0.4) * 100,
  ) / 100
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

// ── Churn Risk Score ──────────────────────────────────────────
export function calcChurnRiskScore(
  healthScore: number,
  invoiceStatus: InvoiceStatus,
  daysActive: number,
  account: Account,
): number {
  let churnAdditif = 0
  if (invoiceStatus.has_overdue) churnAdditif += 15
  if (daysActive === 0) churnAdditif += 20

  if (account.contract_end_date) {
    const daysUntilRenewal = Math.floor(
      (new Date(account.contract_end_date).getTime() - Date.now()) / 86400000,
    )
    if (daysUntilRenewal <= 30 && daysUntilRenewal >= 0) churnAdditif += 10
    if (daysUntilRenewal < 0) churnAdditif += 25
  }

  return Math.max(0, Math.min(100, Math.round((100 - healthScore + churnAdditif) * 100) / 100))
}
