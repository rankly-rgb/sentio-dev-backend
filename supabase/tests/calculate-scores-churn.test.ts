import { describe, it, expect } from 'vitest'

// ── Mirror of the D1 churned-state decision (calculate-scores/index.ts,
// scoreAccountPure) — calculate-scores/index.ts imports jsr: specifiers
// (Deno edge-runtime types, supabase-js) that Vitest/Node cannot resolve,
// so the isolated decision is mirrored here rather than imported directly
// (same convention as churn-alert.test.ts / insights-crud.test.ts). ────

interface ChurnResult {
  churn_risk_score: number | null
  churn_risk_band: 'low' | 'watch' | 'high' | 'churned'
  risk_signals_triggered: unknown[]
  risk_signals_evaluated: number
}

function isChurned(mrrCurrentCents: number, subscriptionCanceled: boolean): boolean {
  return mrrCurrentCents === 0 || subscriptionCanceled
}

function frozenChurnedResult(): ChurnResult {
  return { churn_risk_score: null, churn_risk_band: 'churned', risk_signals_triggered: [], risk_signals_evaluated: 0 }
}

describe('D1 — churned account state (2026-08-02)', () => {
  it('a churned account is detected when mrr_cents = 0', () => {
    expect(isChurned(0, false)).toBe(true)
  })

  it('a churned account is detected when the subscription is canceled, even with mrr_cents > 0', () => {
    expect(isChurned(4900, true)).toBe(true)
  })

  it('an active account with positive MRR and no canceled subscription is not churned', () => {
    expect(isChurned(4900, false)).toBe(false)
  })

  it('the frozen churned result has a null score, never a clamped 0', () => {
    const result = frozenChurnedResult()
    expect(result.churn_risk_score).toBeNull()
    expect(result.churn_risk_score).not.toBe(0)
  })

  it('the frozen churned result uses the churned band, distinct from low/watch/high', () => {
    const result = frozenChurnedResult()
    expect(result.churn_risk_band).toBe('churned')
    expect(['low', 'watch', 'high']).not.toContain(result.churn_risk_band)
  })

  it('the frozen churned result carries no risk signals — none were evaluated', () => {
    const result = frozenChurnedResult()
    expect(result.risk_signals_triggered).toEqual([])
    expect(result.risk_signals_evaluated).toBe(0)
  })
})
