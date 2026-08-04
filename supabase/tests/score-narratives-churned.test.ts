import { describe, it, expect } from 'vitest'
import { generateNarrativesV3, type NarrativeInputsV3 } from '../functions/_shared/score-narratives'

// Bug found during the 2026-08-04 adversarial self-review of D-NEXT's
// isChurned consumers (IMPLEMENTATION_LOG.md): narrativePaymentHealth
// (the active v3 path, generateNarrativesV3 → accounts-api + calculate-scores)
// special-cased mrr_cents === 0 with "subscription canceled or suspended" —
// the old D1 predicate. An invoice-only/usage-based account can have
// mrr_cents=0 without being churned (isAccountChurned() requires all known
// subscriptions canceled — docs/openspec.md §5), so this text was factually
// wrong for that account type. Fixed to key off churn_risk_band==='churned'.
const baseInput: NarrativeInputsV3 = {
  health_score_points: 70,
  health_score_status: 'complete',
  payment_health_score: 95,
  revenue_dynamics_score: 80,
  contract_renewal_score: 80,
  mrr_cents: 0,
  overdue_count: 0,
  overdue_amount_cents: 0,
  contract_end_date: null,
  billing_interval: null,
  churn_risk_band: 'churned',
}

describe('generateNarrativesV3 — financial_narrative churned wording (mirror of narrativePaymentHealth)', () => {
  it('churn_risk_band=churned → churn-specific wording', () => {
    const narratives = generateNarrativesV3(baseInput)
    expect(narratives.financial_narrative).toBe('Account churned — subscription canceled.')
  })

  it('REGRESSION: mrr_cents=0 with churn_risk_band=low (invoice-only, not churned) → normal payment-health wording, not "canceled or suspended"', () => {
    const narratives = generateNarrativesV3({ ...baseInput, churn_risk_band: 'low' })
    expect(narratives.financial_narrative).not.toContain('canceled or suspended')
    expect(narratives.financial_narrative).toBe('No overdue invoices. MRR: $0.')
  })

  it('mrr_cents=0, churn_risk_band=low, no payment_health_score yet → explicit "not available" wording', () => {
    const narratives = generateNarrativesV3({ ...baseInput, churn_risk_band: 'low', payment_health_score: null })
    expect(narratives.financial_narrative).toBe('Payment health score not available — not enough invoice history yet.')
  })

  it('churn_risk_band=null (not yet scored) does not trigger churned wording', () => {
    const narratives = generateNarrativesV3({ ...baseInput, churn_risk_band: null, mrr_cents: 500000 })
    expect(narratives.financial_narrative).not.toContain('churned')
  })
})
