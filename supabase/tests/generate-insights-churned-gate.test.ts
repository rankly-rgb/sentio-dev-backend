import { describe, it, expect } from 'vitest'
import { evaluateInsightRules, type InsightInput } from '../functions/_shared/insight-rules'

// ── Mirror of the churned-account gate in generate-insights/index.ts'
// per-account loop (that file imports jsr: specifiers Vitest/Node cannot
// resolve, same convention as calculate-scores-churn.test.ts /
// generate-insights-usage-history.test.ts).
//
// Bug found during the 2026-08-04 adversarial self-review of D-NEXT's
// isChurned consumers (IMPLEMENTATION_LOG.md): this gate still read
// `account.mrr_cents === 0`, the OLD D1 definition of "churned" — never
// updated when D-NEXT (docs/openspec.md §5, CLAUDE.md) decoupled isChurned
// from mrr_cents===0. An invoice-only or fully-metered account has
// mrr_status='unavailable' and mrr_cents=0 without being churned — exactly
// the account type D-NEXT exists to stop mis-classifying, and the one that
// most needs insights, not fewer. Fixed to gate on churn_risk_band==='churned'
// (already reconciled with isAccountChurned() by scoreAccountPure — same
// source dashboard-api/get-today-status already use for this predicate).
function candidatesForAccount(churnRiskBand: string | null, input: InsightInput) {
  return churnRiskBand === 'churned' ? [] : evaluateInsightRules(input)
}

const baseInput: InsightInput = {
  account_id: 'acc-001',
  organization_id: 'org-001',
  health_score: 20,
  churn_risk_score: 90,
  expansion_score: 0,
  mrr_cents: 0,
  contract_end_date: null,
  has_overdue_invoices: true,
  overdue_days: 30,
  usage_score_current: 10,
  usage_score_previous: 60,
  created_at: '2025-06-01T00:00:00Z',
}

describe('generate-insights churned gate (mirror)', () => {
  it('churn_risk_band=churned → no candidates, regardless of how alarming the input looks', () => {
    expect(candidatesForAccount('churned', baseInput)).toEqual([])
  })

  it('REGRESSION: mrr_cents=0 alone (invoice-only / fully-metered, mrr_status=unavailable) no longer suppresses insights', () => {
    // Same mrr_cents=0 as the churned case above, but churn_risk_band is NOT
    // 'churned' (e.g. this account was never eligible for the D1 short-circuit
    // because isAccountChurned() requires ALL subscriptions canceled, not
    // mrr_cents===0 — an invoice-only account has zero known subscriptions).
    const candidates = candidatesForAccount('high', baseInput)
    expect(candidates.length).toBeGreaterThan(0)
  })

  it('churn_risk_band=null (not yet scored) → gate does not suppress', () => {
    const candidates = candidatesForAccount(null, baseInput)
    expect(candidates.length).toBeGreaterThan(0)
  })

  it('churn_risk_band=low (never "churned") with a healthy account → normal rule evaluation runs (not short-circuited)', () => {
    const healthyInput: InsightInput = { ...baseInput, mrr_cents: 150000, has_overdue_invoices: false, overdue_days: 0, health_score: 80, churn_risk_score: 10 }
    const candidates = candidatesForAccount('low', healthyInput)
    expect(candidates.map((c) => c.insight_type)).toEqual(['account_health_summary'])
  })
})
