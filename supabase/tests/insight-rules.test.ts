import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  evaluateInsightRules,
  evaluateChurnPrediction,
  evaluateExpansionOpportunity,
  evaluateRenewalAlert,
  evaluatePaymentRisk,
  evaluateUsageDrop,
  type InsightInput,
} from '../functions/_shared/insight-rules'

// ── Base test data ───────────────────────────────────────────

const baseInput: InsightInput = {
  account_id: 'acc-001',
  organization_id: 'org-001',
  health_score: 65,
  churn_risk_score: 40,
  expansion_score: 50,
  mrr_cents: 150000, // 1500 €
  contract_end_date: null,
  has_overdue_invoices: false,
  overdue_days: 0,
  usage_score_current: 60,
  usage_score_previous: 60,
  created_at: '2025-06-01T00:00:00Z',
}

// ── Mock Date for renewal tests ──────────────────────────────

beforeEach(() => {
  // Fix "now" to 2026-03-04 for predictable daysUntil calculations
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 2, 4))
})

afterEach(() => {
  vi.useRealTimers()
})

// Helper to create a date N days from 2026-03-04
function futureDateStr(daysFromNow: number): string {
  const d = new Date(2026, 2, 4 + daysFromNow)
  return d.toISOString().split('T')[0]
}

// ── Churn Prediction ─────────────────────────────────────────

describe('evaluateChurnPrediction', () => {
  it('returns null when churn_risk < 70', () => {
    expect(evaluateChurnPrediction({ ...baseInput, churn_risk_score: 69 })).toBeNull()
  })

  it('returns high priority when churn_risk >= 70 and < 85', () => {
    const result = evaluateChurnPrediction({ ...baseInput, churn_risk_score: 75 })
    expect(result).not.toBeNull()
    expect(result!.insight_type).toBe('churn_prediction')
    expect(result!.priority).toBe('high')
  })

  it('returns critical priority when churn_risk >= 85', () => {
    const result = evaluateChurnPrediction({ ...baseInput, churn_risk_score: 90 })
    expect(result).not.toBeNull()
    expect(result!.priority).toBe('critical')
  })

  it('confidence is capped at 95', () => {
    const result = evaluateChurnPrediction({ ...baseInput, churn_risk_score: 100 })
    expect(result!.confidence_score).toBe(95)
  })

  it('mrr_impact_cents equals account MRR', () => {
    const result = evaluateChurnPrediction({ ...baseInput, churn_risk_score: 80, mrr_cents: 200000 })
    expect(result!.mrr_impact_cents).toBe(200000)
  })

  it('includes source_scores with churn_risk and health', () => {
    const result = evaluateChurnPrediction({ ...baseInput, churn_risk_score: 75, health_score: 30 })
    expect(result!.source_scores).toEqual({ churn_risk_score: 75, health_score: 30 })
  })
})

// ── Expansion Opportunity ────────────────────────────────────

describe('evaluateExpansionOpportunity', () => {
  it('returns null when expansion < 70', () => {
    expect(evaluateExpansionOpportunity({ ...baseInput, expansion_score: 69, health_score: 80 })).toBeNull()
  })

  it('returns null when health < 60 even if expansion >= 70', () => {
    expect(evaluateExpansionOpportunity({ ...baseInput, expansion_score: 80, health_score: 55 })).toBeNull()
  })

  it('returns medium priority when expansion 70-84', () => {
    const result = evaluateExpansionOpportunity({ ...baseInput, expansion_score: 75, health_score: 70 })
    expect(result).not.toBeNull()
    expect(result!.priority).toBe('medium')
  })

  it('returns high priority when expansion >= 85', () => {
    const result = evaluateExpansionOpportunity({ ...baseInput, expansion_score: 90, health_score: 80 })
    expect(result!.priority).toBe('high')
  })

  it('mrr_impact is 30% of MRR', () => {
    const result = evaluateExpansionOpportunity({ ...baseInput, expansion_score: 80, health_score: 70, mrr_cents: 100000 })
    expect(result!.mrr_impact_cents).toBe(30000)
  })
})

// ── Renewal Alert ────────────────────────────────────────────

describe('evaluateRenewalAlert', () => {
  it('returns null when contract_end_date is null', () => {
    expect(evaluateRenewalAlert({ ...baseInput, contract_end_date: null })).toBeNull()
  })

  it('returns null when contract_end_date > 60 days away', () => {
    expect(evaluateRenewalAlert({ ...baseInput, contract_end_date: futureDateStr(90) })).toBeNull()
  })

  it('returns high priority when 30 < days <= 60', () => {
    const result = evaluateRenewalAlert({ ...baseInput, contract_end_date: futureDateStr(45) })
    expect(result).not.toBeNull()
    expect(result!.priority).toBe('high')
    expect(result!.confidence_score).toBe(75)
  })

  it('returns critical priority when days <= 30', () => {
    const result = evaluateRenewalAlert({ ...baseInput, contract_end_date: futureDateStr(20) })
    expect(result).not.toBeNull()
    expect(result!.priority).toBe('critical')
    expect(result!.confidence_score).toBe(90)
  })

  it('returns critical insight when contract already expired (days < 0)', () => {
    const result = evaluateRenewalAlert({ ...baseInput, contract_end_date: '2026-02-01' })
    expect(result).not.toBeNull()
    expect(result!.priority).toBe('critical')
    expect(result!.confidence_score).toBe(95)
    expect(result!.insight_type).toBe('renewal_alert')
  })
})

// ── Payment Risk ─────────────────────────────────────────────

describe('evaluatePaymentRisk', () => {
  it('returns null when no overdue invoices', () => {
    expect(evaluatePaymentRisk({ ...baseInput, has_overdue_invoices: false })).toBeNull()
  })

  it('returns null when overdue_days <= 15', () => {
    expect(evaluatePaymentRisk({ ...baseInput, has_overdue_invoices: true, overdue_days: 10 })).toBeNull()
  })

  it('returns high priority when 15 < overdue_days <= 30', () => {
    const result = evaluatePaymentRisk({ ...baseInput, has_overdue_invoices: true, overdue_days: 20 })
    expect(result).not.toBeNull()
    expect(result!.priority).toBe('high')
    expect(result!.confidence_score).toBe(70)
  })

  it('returns critical priority when overdue_days > 30', () => {
    const result = evaluatePaymentRisk({ ...baseInput, has_overdue_invoices: true, overdue_days: 45 })
    expect(result!.priority).toBe('critical')
    expect(result!.confidence_score).toBe(85)
  })

  it('mrr_impact equals account MRR', () => {
    const result = evaluatePaymentRisk({ ...baseInput, has_overdue_invoices: true, overdue_days: 25, mrr_cents: 300000 })
    expect(result!.mrr_impact_cents).toBe(300000)
  })
})

// ── Usage Drop ───────────────────────────────────────────────

describe('evaluateUsageDrop', () => {
  it('returns null when no previous data', () => {
    expect(evaluateUsageDrop({ ...baseInput, usage_score_previous: null })).toBeNull()
  })

  it('returns null when previous score is 0', () => {
    expect(evaluateUsageDrop({ ...baseInput, usage_score_previous: 0 })).toBeNull()
  })

  it('returns null when usage has not dropped > 30%', () => {
    expect(evaluateUsageDrop({ ...baseInput, usage_score_current: 75, usage_score_previous: 100 })).toBeNull()
  })

  it('returns medium priority when drop is 30-49%', () => {
    const result = evaluateUsageDrop({ ...baseInput, usage_score_current: 60, usage_score_previous: 100 })
    expect(result).not.toBeNull()
    expect(result!.insight_type).toBe('usage_drop')
    expect(result!.priority).toBe('medium')
  })

  it('returns high priority when drop >= 50%', () => {
    const result = evaluateUsageDrop({ ...baseInput, usage_score_current: 40, usage_score_previous: 100 })
    expect(result!.priority).toBe('high')
  })

  it('confidence is proportional to drop percentage', () => {
    const result35 = evaluateUsageDrop({ ...baseInput, usage_score_current: 65, usage_score_previous: 100 })
    const result60 = evaluateUsageDrop({ ...baseInput, usage_score_current: 40, usage_score_previous: 100 })
    expect(result60!.confidence_score).toBeGreaterThan(result35!.confidence_score)
  })

  it('mrr_impact is proportional to drop', () => {
    const result = evaluateUsageDrop({ ...baseInput, usage_score_current: 50, usage_score_previous: 100, mrr_cents: 200000 })
    // 50% drop → 50% of MRR
    expect(result!.mrr_impact_cents).toBe(100000)
  })

  it('confidence is capped at 90', () => {
    const result = evaluateUsageDrop({ ...baseInput, usage_score_current: 5, usage_score_previous: 100 })
    expect(result!.confidence_score).toBeLessThanOrEqual(90)
  })
})

// ── evaluateInsightRules (orchestrator) ──────────────────────

describe('evaluateInsightRules', () => {
  it('returns empty array for healthy account with no issues', () => {
    const result = evaluateInsightRules(baseInput)
    expect(result).toEqual([])
  })

  it('returns churn_prediction for high churn risk account', () => {
    const result = evaluateInsightRules({ ...baseInput, churn_risk_score: 80 })
    expect(result).toHaveLength(1)
    expect(result[0].insight_type).toBe('churn_prediction')
  })

  it('returns expansion_opportunity for high expansion + healthy account', () => {
    const result = evaluateInsightRules({ ...baseInput, expansion_score: 80, health_score: 75 })
    expect(result).toHaveLength(1)
    expect(result[0].insight_type).toBe('expansion_opportunity')
  })

  it('returns multiple insights when multiple conditions are met', () => {
    const input: InsightInput = {
      ...baseInput,
      churn_risk_score: 80,
      has_overdue_invoices: true,
      overdue_days: 20,
      usage_score_current: 30,
      usage_score_previous: 80,
    }
    const result = evaluateInsightRules(input)
    const types = result.map((r) => r.insight_type)
    expect(types).toContain('churn_prediction')
    expect(types).toContain('payment_risk')
    expect(types).toContain('usage_drop')
    expect(result.length).toBeGreaterThanOrEqual(3)
  })

  it('returns renewal_alert for contract ending soon', () => {
    const result = evaluateInsightRules({ ...baseInput, contract_end_date: futureDateStr(25) })
    expect(result).toHaveLength(1)
    expect(result[0].insight_type).toBe('renewal_alert')
  })

  it('all insights have required fields', () => {
    const result = evaluateInsightRules({ ...baseInput, churn_risk_score: 90 })
    for (const insight of result) {
      expect(insight.insight_type).toBeDefined()
      expect(insight.title).toBeTruthy()
      expect(insight.description).toBeTruthy()
      expect(insight.recommended_action).toBeTruthy()
      expect(insight.priority).toBeDefined()
      expect(insight.confidence_score).toBeGreaterThanOrEqual(0)
      expect(insight.confidence_score).toBeLessThanOrEqual(100)
      expect(typeof insight.mrr_impact_cents).toBe('number')
      expect(insight.source_scores).toBeDefined()
    }
  })

  it('descriptions contain MRR in euros', () => {
    const result = evaluateInsightRules({ ...baseInput, churn_risk_score: 80, mrr_cents: 250000 })
    expect(result[0].description).toContain('€')
  })

  it('titles are in French', () => {
    const result = evaluateInsightRules({ ...baseInput, churn_risk_score: 80 })
    // French title should contain accented characters or French words
    expect(result[0].title).toMatch(/[éèêëàâùûôîïç]|churn|risque|détecté/i)
  })
})
