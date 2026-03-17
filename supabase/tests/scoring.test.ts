import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  calcUsageScore,
  calcFinancialScore,
  calcEngagementScore,
  calcContractScore,
  calcExpansionScore,
  calcHealthScore,
  calcChurnRiskScore,
  determineSegmentTypes,
  type Account,
  type UsageStats,
  type HubspotData,
  type InvoiceStatus,
} from '../functions/_shared/scoring'

// ── Usage Score ───────────────────────────────────────────────

describe('calcUsageScore', () => {
  const emptyStats: UsageStats = {
    login_count: 0,
    feature_count: 0,
    total_events: 0,
    distinct_features: 0,
    days_active: 0,
  }

  it('returns 50 (neutral) for zero events', () => {
    expect(calcUsageScore(emptyStats)).toBe(50)
  })

  it('returns calculated score (not neutral default) for non-zero events', () => {
    const stats: UsageStats = { ...emptyStats, total_events: 10, days_active: 5, distinct_features: 3 }
    const score = calcUsageScore(stats)
    expect(score).toBeGreaterThan(0)
    expect(score).not.toBe(50) // Not the neutral default
  })

  it('returns high score for max activity', () => {
    const stats: UsageStats = {
      login_count: 100,
      feature_count: 500,
      total_events: 10000,
      distinct_features: 20,
      days_active: 30,
    }
    expect(calcUsageScore(stats)).toBeGreaterThanOrEqual(90)
  })

  it('score is always between 0 and 100', () => {
    const stats: UsageStats = {
      login_count: 1000,
      feature_count: 5000,
      total_events: 1000000,
      distinct_features: 100,
      days_active: 100,
    }
    const score = calcUsageScore(stats)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(100)
  })
})

// ── Financial Score ───────────────────────────────────────────

describe('calcFinancialScore', () => {
  const noOverdue: InvoiceStatus = { has_overdue: false, overdue_count: 0 }

  it('returns 0 for null MRR', () => {
    expect(calcFinancialScore(null, noOverdue, 10000)).toBe(0)
  })

  it('returns 0 for zero MRR', () => {
    expect(calcFinancialScore(0, noOverdue, 10000)).toBe(0)
  })

  it('returns 100 for top account with no overdue', () => {
    expect(calcFinancialScore(10000, noOverdue, 10000)).toBe(100)
  })

  it('returns 50 for half MRR', () => {
    expect(calcFinancialScore(5000, noOverdue, 10000)).toBe(50)
  })

  it('applies 20% penalty per overdue invoice', () => {
    const oneOverdue: InvoiceStatus = { has_overdue: true, overdue_count: 1 }
    const baseScore = calcFinancialScore(10000, noOverdue, 10000)
    const penalizedScore = calcFinancialScore(10000, oneOverdue, 10000)
    expect(penalizedScore).toBe(baseScore * 0.8)
  })

  it('caps penalty at 100% (5+ overdue invoices)', () => {
    const fiveOverdue: InvoiceStatus = { has_overdue: true, overdue_count: 5 }
    expect(calcFinancialScore(10000, fiveOverdue, 10000)).toBe(0)
  })

  it('returns 50 when maxMrr is 0', () => {
    expect(calcFinancialScore(5000, noOverdue, 0)).toBe(50)
  })
})

// ── Engagement Score ──────────────────────────────────────────

describe('calcEngagementScore', () => {
  it('returns 50 for null HubSpot data', () => {
    expect(calcEngagementScore(null)).toBe(50)
  })

  it('adds 15 for zero open tickets', () => {
    const hubspot: HubspotData = { nps_score: null, open_ticket_count: 0, open_deal_count: null, last_meeting_date: null }
    expect(calcEngagementScore(hubspot)).toBe(65)
  })

  it('subtracts 5 for 1-2 open tickets', () => {
    const hubspot: HubspotData = { nps_score: null, open_ticket_count: 2, open_deal_count: null, last_meeting_date: null }
    expect(calcEngagementScore(hubspot)).toBe(45)
  })

  it('subtracts 25 for 3+ open tickets', () => {
    const hubspot: HubspotData = { nps_score: null, open_ticket_count: 5, open_deal_count: null, last_meeting_date: null }
    expect(calcEngagementScore(hubspot)).toBe(25)
  })

  it('adds 25 for meeting < 30 days ago', () => {
    const recent = new Date(Date.now() - 10 * 86400000).toISOString().split('T')[0]
    const hubspot: HubspotData = { nps_score: null, open_ticket_count: null, open_deal_count: null, last_meeting_date: recent }
    expect(calcEngagementScore(hubspot)).toBe(75)
  })

  it('adds 10 for meeting 30-60 days ago', () => {
    const mid = new Date(Date.now() - 45 * 86400000).toISOString().split('T')[0]
    const hubspot: HubspotData = { nps_score: null, open_ticket_count: null, open_deal_count: null, last_meeting_date: mid }
    expect(calcEngagementScore(hubspot)).toBe(60)
  })

  it('subtracts 15 for meeting > 90 days ago', () => {
    const old = new Date(Date.now() - 120 * 86400000).toISOString().split('T')[0]
    const hubspot: HubspotData = { nps_score: null, open_ticket_count: null, open_deal_count: null, last_meeting_date: old }
    expect(calcEngagementScore(hubspot)).toBe(35)
  })

  it('subtracts 25 for meeting > 180 days ago', () => {
    const veryOld = new Date(Date.now() - 200 * 86400000).toISOString().split('T')[0]
    const hubspot: HubspotData = { nps_score: null, open_ticket_count: null, open_deal_count: null, last_meeting_date: veryOld }
    expect(calcEngagementScore(hubspot)).toBe(25) // 50 - 25
  })

  it('is clamped between 0 and 100', () => {
    // Worst case: 3+ tickets (-25) + meeting > 180 days (-25) = 50-25-25 = 0
    const hubspot: HubspotData = {
      nps_score: null,
      open_ticket_count: 10,
      open_deal_count: null,
      last_meeting_date: '2020-01-01',
    }
    const score = calcEngagementScore(hubspot)
    expect(score).toBe(0)
  })
})

// ── Contract Score ────────────────────────────────────────────

describe('calcContractScore', () => {
  const baseAccount: Account = {
    id: 'a1', organization_id: 'o1', mrr_cents: null,
    seat_count: null, seat_limit: null, contract_end_date: null,
    health_score: null, churn_risk_score: null,
  }

  it('returns 50 for null contract date', () => {
    expect(calcContractScore(baseAccount)).toBe(50)
  })

  it('returns 10 for expired contract', () => {
    const acct = { ...baseAccount, contract_end_date: '2020-01-01' }
    expect(calcContractScore(acct)).toBe(10)
  })

  it('returns 25 for contract expiring within 30 days', () => {
    const future15d = new Date(Date.now() + 15 * 86400000).toISOString().split('T')[0]
    const acct = { ...baseAccount, contract_end_date: future15d }
    expect(calcContractScore(acct)).toBe(25)
  })

  it('returns 50 for contract expiring within 60 days', () => {
    const future45d = new Date(Date.now() + 45 * 86400000).toISOString().split('T')[0]
    const acct = { ...baseAccount, contract_end_date: future45d }
    expect(calcContractScore(acct)).toBe(50)
  })

  it('returns 75 for contract expiring within 90 days', () => {
    const future75d = new Date(Date.now() + 75 * 86400000).toISOString().split('T')[0]
    const acct = { ...baseAccount, contract_end_date: future75d }
    expect(calcContractScore(acct)).toBe(75)
  })

  it('returns 100 for contract expiring after 90 days', () => {
    const future180d = new Date(Date.now() + 180 * 86400000).toISOString().split('T')[0]
    const acct = { ...baseAccount, contract_end_date: future180d }
    expect(calcContractScore(acct)).toBe(100)
  })
})

// ── Expansion Score ───────────────────────────────────────────

describe('calcExpansionScore', () => {
  const baseAccount: Account = {
    id: 'a1', organization_id: 'o1', mrr_cents: null,
    seat_count: null, seat_limit: null, contract_end_date: null,
    health_score: null, churn_risk_score: null,
  }
  const baseStats: UsageStats = {
    login_count: 0, feature_count: 0, total_events: 0,
    distinct_features: 0, days_active: 0,
  }

  it('returns neutral (30) for no seat data and no features', () => {
    // seatUsagePct = 50 (neutral), featureCeiling = 0 → (50*0.6 + 0*0.4) = 30
    expect(calcExpansionScore(baseAccount, baseStats)).toBe(30)
  })

  it('returns 100 for full seats and max features', () => {
    const acct = { ...baseAccount, seat_count: 10, seat_limit: 10 }
    const stats = { ...baseStats, distinct_features: 10 }
    expect(calcExpansionScore(acct, stats)).toBe(100)
  })

  it('uses neutral seat score when no limit', () => {
    const acct = { ...baseAccount, seat_count: 5, seat_limit: null }
    const stats = { ...baseStats, distinct_features: 5 }
    // neutral 50 * 0.6 + 50 * 0.4 = 30 + 20 = 50
    expect(calcExpansionScore(acct, stats)).toBe(50)
  })
})

// ── Health Score composite ────────────────────────────────────

describe('calcHealthScore — 4 dimensions (usageTrackerConnected: true)', () => {
  it('follows weighted formula: U×35 + F×25 + E×20 + C×20', () => {
    const health = calcHealthScore({
      usageScore: 80, financialScore: 60, engagementScore: 70, contractScore: 90,
      usageTrackerConnected: true,
    })
    const expected = Math.round((80 * 0.35 + 60 * 0.25 + 70 * 0.20 + 90 * 0.20) * 100) / 100
    expect(health).toBe(expected)
  })

  it('returns 0 for all zero inputs', () => {
    expect(calcHealthScore({
      usageScore: 0, financialScore: 0, engagementScore: 0, contractScore: 0,
      usageTrackerConnected: true,
    })).toBe(0)
  })

  it('returns 100 for all 100 inputs', () => {
    expect(calcHealthScore({
      usageScore: 100, financialScore: 100, engagementScore: 100, contractScore: 100,
      usageTrackerConnected: true,
    })).toBe(100)
  })
})

// API contract : product_usage_score = null quand tracker non connecté
// Ce test documente que calcUsageScore retourne 50 pour zéro events MAIS
// que cette valeur ne doit JAMAIS être utilisée dans le calcul Health ou
// stockée en DB quand usageTrackerConnected = false.
// Le calcul Health doit utiliser la formule 3D dans ce cas.
describe('product_usage_score null contract (usageTrackerConnected: false)', () => {
  it('calcUsageScore returns 50 for zero events (neutral fallback)', () => {
    // NOTE: cette valeur ne doit PAS être stockée en DB quand le tracker est déconnecté
    const stats: UsageStats = { login_count: 0, feature_count: 0, total_events: 0, distinct_features: 0, days_active: 0 }
    expect(calcUsageScore(stats)).toBe(50)
  })

  it('health score with tracker disconnected excludes usage entirely (not 50 neutral)', () => {
    // Vérifier que la formule 3D produit un résultat différent de la formule 4D avec usage=50
    const health3d = calcHealthScore({ financialScore: 80, engagementScore: 60, contractScore: 70, usageTrackerConnected: false })
    const health4d50 = calcHealthScore({ usageScore: 50, financialScore: 80, engagementScore: 60, contractScore: 70, usageTrackerConnected: true })
    // 3D: 80*0.34 + 60*0.33 + 70*0.33 = 70.7
    // 4D: 50*0.35 + 80*0.25 + 60*0.20 + 70*0.20 = 63.5
    // Les deux formules produisent des résultats distincts — preuves que le mode tracker change le calcul
    expect(health3d).not.toBe(health4d50)
  })
})

describe('calcHealthScore — 3 dimensions (usageTrackerConnected: false)', () => {
  it('follows redistributed weights: F×34 + E×33 + C×33', () => {
    const health = calcHealthScore({
      financialScore: 60, engagementScore: 70, contractScore: 90,
      usageTrackerConnected: false,
    })
    const expected = Math.round((60 * 0.34 + 70 * 0.33 + 90 * 0.33) * 100) / 100
    expect(health).toBe(expected)
  })

  it('ignores usageScore even if provided', () => {
    const withUsage = calcHealthScore({
      usageScore: 100, financialScore: 60, engagementScore: 70, contractScore: 90,
      usageTrackerConnected: false,
    })
    const withoutUsage = calcHealthScore({
      financialScore: 60, engagementScore: 70, contractScore: 90,
      usageTrackerConnected: false,
    })
    expect(withUsage).toBe(withoutUsage)
  })

  it('returns 0 for all zero inputs', () => {
    expect(calcHealthScore({
      financialScore: 0, engagementScore: 0, contractScore: 0,
      usageTrackerConnected: false,
    })).toBe(0)
  })

  it('returns 100 for all 100 inputs', () => {
    expect(calcHealthScore({
      financialScore: 100, engagementScore: 100, contractScore: 100,
      usageTrackerConnected: false,
    })).toBe(100)
  })

  it('result is between 0 and 100', () => {
    const health = calcHealthScore({
      financialScore: 45, engagementScore: 78, contractScore: 33,
      usageTrackerConnected: false,
    })
    expect(health).toBeGreaterThanOrEqual(0)
    expect(health).toBeLessThanOrEqual(100)
  })
})

// ── Churn Risk Score ──────────────────────────────────────────

describe('calcChurnRiskScore', () => {
  const baseAccount: Account = {
    id: 'a1', organization_id: 'o1', mrr_cents: null,
    seat_count: null, seat_limit: null, contract_end_date: null,
    health_score: null, churn_risk_score: null,
  }
  const noOverdue: InvoiceStatus = { has_overdue: false, overdue_count: 0 }

  it('is inverse of health score (base case)', () => {
    const risk = calcChurnRiskScore(80, noOverdue, 10, baseAccount)
    expect(risk).toBe(20)
  })

  it('adds 15 for overdue invoices', () => {
    const overdue: InvoiceStatus = { has_overdue: true, overdue_count: 1 }
    const risk = calcChurnRiskScore(80, overdue, 10, baseAccount)
    expect(risk).toBe(35) // 100 - 80 + 15 = 35
  })

  it('adds 20 for zero activity when tracker connected', () => {
    const risk = calcChurnRiskScore(80, noOverdue, 0, baseAccount, true)
    expect(risk).toBe(40) // 100 - 80 + 20 = 40
  })

  it('does NOT add 20 for zero activity when tracker not connected', () => {
    const risk = calcChurnRiskScore(80, noOverdue, 0, baseAccount, false)
    expect(risk).toBe(20) // 100 - 80 = 20, no +20 penalty
  })

  it('does NOT add 20 for zero activity when tracker undefined', () => {
    const risk = calcChurnRiskScore(80, noOverdue, 0, baseAccount)
    expect(risk).toBe(20) // 100 - 80 = 20, no +20 penalty (backwards compat)
  })

  it('adds 25 for expired contract', () => {
    const acct = { ...baseAccount, contract_end_date: '2020-01-01' }
    const risk = calcChurnRiskScore(80, noOverdue, 10, acct)
    expect(risk).toBe(45) // 100 - 80 + 25 = 45
  })

  it('is capped at 100', () => {
    const overdue: InvoiceStatus = { has_overdue: true, overdue_count: 1 }
    const acct = { ...baseAccount, contract_end_date: '2020-01-01' }
    // 100 - 0 + 15 + 20 + 25 = 160 → capped at 100
    const risk = calcChurnRiskScore(0, overdue, 0, acct, true)
    expect(risk).toBe(100)
  })

  it('is floored at 0', () => {
    const risk = calcChurnRiskScore(100, noOverdue, 30, baseAccount)
    expect(risk).toBe(0)
  })
})

// ── Segment Assignment ────────────────────────────────────────

describe('determineSegmentTypes', () => {
  const baseScores = { health_score: 50, churn_risk_score: 50, expansion_score: 30 }
  const oldDate = '2020-01-01T00:00:00Z'
  const recentDate = new Date(Date.now() - 30 * 86400000).toISOString()

  it('assigns "nouveaux" for accounts < 90 days old', () => {
    const segments = determineSegmentTypes(baseScores, 5000, false, recentDate)
    expect(segments).toContain('nouveaux')
  })

  it('does not assign "nouveaux" for old accounts', () => {
    const segments = determineSegmentTypes(baseScores, 5000, false, oldDate)
    expect(segments).not.toContain('nouveaux')
  })

  it('assigns "en_churn" when mrr_cents = 0', () => {
    const segments = determineSegmentTypes(baseScores, 0, false, oldDate)
    expect(segments).toContain('en_churn')
    // en_churn is exclusive with other score-based segments
    expect(segments).not.toContain('stables')
    expect(segments).not.toContain('en_danger_critique')
  })

  it('assigns "impayes" when has overdue invoices (mrr > 0)', () => {
    const segments = determineSegmentTypes(baseScores, 5000, true, oldDate)
    expect(segments).toContain('impayes')
    expect(segments).not.toContain('a_risque_leger')
  })

  it('assigns "en_danger_critique" for churn_risk >= 70', () => {
    const scores = { health_score: 25, churn_risk_score: 75, expansion_score: 10 }
    const segments = determineSegmentTypes(scores, 5000, false, oldDate)
    expect(segments).toContain('en_danger_critique')
    expect(segments).toHaveLength(1)
  })

  it('assigns "a_risque_leger" for 50 <= churn_risk < 70', () => {
    const scores = { health_score: 45, churn_risk_score: 55, expansion_score: 20 }
    const segments = determineSegmentTypes(scores, 5000, false, oldDate)
    expect(segments).toContain('a_risque_leger')
    expect(segments).toHaveLength(1)
  })

  it('assigns "champions" for health >= 80', () => {
    const scores = { health_score: 85, churn_risk_score: 15, expansion_score: 40 }
    const segments = determineSegmentTypes(scores, 5000, false, oldDate)
    expect(segments).toContain('champions')
    expect(segments).toHaveLength(1)
  })

  it('assigns "en_expansion" for expansion >= 70 and health >= 60', () => {
    const scores = { health_score: 65, churn_risk_score: 35, expansion_score: 75 }
    const segments = determineSegmentTypes(scores, 5000, false, oldDate)
    expect(segments).toContain('en_expansion')
    expect(segments).toHaveLength(1)
  })

  it('assigns "stables" as default fallback', () => {
    const scores = { health_score: 55, churn_risk_score: 40, expansion_score: 30 }
    const segments = determineSegmentTypes(scores, 5000, false, oldDate)
    expect(segments).toEqual(['stables'])
  })

  it('can assign both "nouveaux" and a score-based segment', () => {
    const scores = { health_score: 90, churn_risk_score: 10, expansion_score: 50 }
    const segments = determineSegmentTypes(scores, 5000, false, recentDate)
    expect(segments).toContain('nouveaux')
    expect(segments).toContain('champions')
    expect(segments).toHaveLength(2)
  })

  it('prioritizes "en_churn" over "en_danger_critique" when mrr = 0', () => {
    const scores = { health_score: 10, churn_risk_score: 90, expansion_score: 5 }
    const segments = determineSegmentTypes(scores, 0, false, oldDate)
    expect(segments).toContain('en_churn')
    expect(segments).not.toContain('en_danger_critique')
  })

  it('prioritizes "impayes" over score-based segments when overdue', () => {
    const scores = { health_score: 85, churn_risk_score: 15, expansion_score: 80 }
    const segments = determineSegmentTypes(scores, 5000, true, oldDate)
    expect(segments).toContain('impayes')
    expect(segments).not.toContain('champions')
    expect(segments).not.toContain('en_expansion')
  })
})

// ── Health Score 2D — HubSpot-only (stripeConnected: false) ──

describe('calcHealthScore — 2 dimensions (stripeConnected: false)', () => {
  it('follows weighted formula: E×60 + C×40', () => {
    const health = calcHealthScore({
      financialScore: 0, engagementScore: 70, contractScore: 50,
      usageTrackerConnected: false, stripeConnected: false,
    })
    const expected = Math.round((70 * 0.60 + 50 * 0.40) * 100) / 100
    expect(health).toBe(expected)
  })

  it('ignores financialScore entirely', () => {
    const withFinancial = calcHealthScore({
      financialScore: 100, engagementScore: 70, contractScore: 50,
      usageTrackerConnected: false, stripeConnected: false,
    })
    const withoutFinancial = calcHealthScore({
      financialScore: 0, engagementScore: 70, contractScore: 50,
      usageTrackerConnected: false, stripeConnected: false,
    })
    expect(withFinancial).toBe(withoutFinancial)
  })

  it('ignores usageScore even if provided', () => {
    const withUsage = calcHealthScore({
      usageScore: 100, financialScore: 0, engagementScore: 70, contractScore: 50,
      usageTrackerConnected: true, stripeConnected: false,
    })
    const withoutUsage = calcHealthScore({
      financialScore: 0, engagementScore: 70, contractScore: 50,
      usageTrackerConnected: false, stripeConnected: false,
    })
    expect(withUsage).toBe(withoutUsage)
  })

  it('returns 0 for all zero inputs', () => {
    expect(calcHealthScore({
      financialScore: 0, engagementScore: 0, contractScore: 0,
      usageTrackerConnected: false, stripeConnected: false,
    })).toBe(0)
  })

  it('returns 100 for all 100 inputs', () => {
    expect(calcHealthScore({
      financialScore: 0, engagementScore: 100, contractScore: 100,
      usageTrackerConnected: false, stripeConnected: false,
    })).toBe(100)
  })

  it('produces higher score than 3D when financial is 0', () => {
    // 2D: 60*0.60 + 50*0.40 = 56
    // 3D: 0*0.34 + 60*0.33 + 50*0.33 = 36.3
    const health2D = calcHealthScore({
      financialScore: 0, engagementScore: 60, contractScore: 50,
      usageTrackerConnected: false, stripeConnected: false,
    })
    const health3D = calcHealthScore({
      financialScore: 0, engagementScore: 60, contractScore: 50,
      usageTrackerConnected: false, stripeConnected: true,
    })
    expect(health2D).toBeGreaterThan(health3D)
  })
})

// ── Churn Risk — stripeConnected: false ──

describe('calcChurnRiskScore — stripeConnected: false', () => {
  const baseAccount: Account = {
    id: 'a1', organization_id: 'o1', mrr_cents: null,
    seat_count: null, seat_limit: null, contract_end_date: null,
    health_score: null, churn_risk_score: null,
  }
  const overdue: InvoiceStatus = { has_overdue: true, overdue_count: 1 }
  const noOverdue: InvoiceStatus = { has_overdue: false, overdue_count: 0 }

  it('does NOT add invoice penalty when Stripe not connected', () => {
    const risk = calcChurnRiskScore(80, overdue, 10, baseAccount, false, false)
    expect(risk).toBe(20) // 100 - 80 = 20, no +15 invoice penalty
  })

  it('still adds contract penalty even without Stripe', () => {
    const acct = { ...baseAccount, contract_end_date: '2020-01-01' }
    const risk = calcChurnRiskScore(80, noOverdue, 10, acct, false, false)
    expect(risk).toBe(45) // 100 - 80 + 25 = 45
  })

  it('adds invoice penalty when stripeConnected is true', () => {
    const risk = calcChurnRiskScore(80, overdue, 10, baseAccount, false, true)
    expect(risk).toBe(35) // 100 - 80 + 15 = 35
  })
})

// ── Segment Assignment — HubSpot-only (stripeConnected: false) ──

describe('determineSegmentTypes — HubSpot-only (stripeConnected: false)', () => {
  const baseScores = { health_score: 50, churn_risk_score: 50, expansion_score: 30 }
  const oldDate = '2020-01-01T00:00:00Z'

  it('does NOT assign "en_churn" even with mrr = 0', () => {
    const scores = { health_score: 50, churn_risk_score: 40, expansion_score: 20 }
    const segments = determineSegmentTypes(scores, 0, false, oldDate, false)
    expect(segments).not.toContain('en_churn')
    expect(segments).toContain('stables')
  })

  it('does NOT assign "impayes" even with overdue invoices', () => {
    const scores = { health_score: 85, churn_risk_score: 15, expansion_score: 80 }
    const segments = determineSegmentTypes(scores, 0, true, oldDate, false)
    expect(segments).not.toContain('impayes')
    expect(segments).toContain('champions')
  })

  it('assigns "en_danger_critique" based on churn_risk score', () => {
    const scores = { health_score: 25, churn_risk_score: 75, expansion_score: 10 }
    const segments = determineSegmentTypes(scores, 0, false, oldDate, false)
    expect(segments).toContain('en_danger_critique')
  })

  it('assigns "champions" based on health score', () => {
    const scores = { health_score: 85, churn_risk_score: 10, expansion_score: 40 }
    const segments = determineSegmentTypes(scores, 0, false, oldDate, false)
    expect(segments).toContain('champions')
  })

  it('assigns "stables" as default for HubSpot-only', () => {
    const scores = { health_score: 55, churn_risk_score: 40, expansion_score: 30 }
    const segments = determineSegmentTypes(scores, 0, false, oldDate, false)
    expect(segments).toEqual(['stables'])
  })

  it('assigns "a_risque_leger" for churn 50-69', () => {
    const scores = { health_score: 45, churn_risk_score: 55, expansion_score: 20 }
    const segments = determineSegmentTypes(scores, 0, false, oldDate, false)
    expect(segments).toContain('a_risque_leger')
  })

  it('assigns "en_expansion" for expansion >= 70 and health >= 60', () => {
    const scores = { health_score: 65, churn_risk_score: 35, expansion_score: 75 }
    const segments = determineSegmentTypes(scores, 0, false, oldDate, false)
    expect(segments).toContain('en_expansion')
  })

  it('retro-compat: stripeConnected undefined behaves as true', () => {
    const scores = { health_score: 10, churn_risk_score: 90, expansion_score: 5 }
    const segments = determineSegmentTypes(scores, 0, false, oldDate)
    expect(segments).toContain('en_churn') // Default (no param) = Stripe connected
  })
})
