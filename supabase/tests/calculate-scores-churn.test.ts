import { describe, it, expect } from 'vitest'
import { isAccountChurned } from '../functions/_shared/mrr-engine'

// ── Mirror of the churned-state decision (calculate-scores/index.ts,
// scoreAccountPure) — calculate-scores/index.ts imports jsr: specifiers
// (Deno edge-runtime types, supabase-js) that Vitest/Node cannot resolve,
// so the isolated decision is mirrored here rather than imported directly
// (same convention as churn-alert.test.ts / insights-crud.test.ts).
//
// D-NEXT (docs/openspec.md §5, 2026-08-04) supersedes the original D1
// (2026-08-02) implementation: `isChurned` no longer short-circuits on
// `mrr_cents === 0` — only `isAccountChurned` (_shared/mrr-engine.ts, real
// production code, imported directly here since it has zero jsr:
// dependencies) decides, based purely on subscription statuses. This
// closes the gap AUDIT_LOGIQUE_METIER_STRIPE.md flagged: a delinquent
// (past_due/unpaid), invoice-only, or metered/usage-based account could
// have `mrr_cents = 0` for reasons that are NOT "the customer left" —
// D1's own stated intent — and was being frozen into the 'churned' state
// regardless, hiding it from every at-risk list/insight/playbook. ────

interface ChurnResult {
  churn_risk_score: number | null
  churn_risk_band: 'low' | 'watch' | 'high' | 'churned'
  risk_signals_triggered: unknown[]
  risk_signals_evaluated: number
}

function isChurned(subscriptionStatuses: string[]): boolean {
  return isAccountChurned(subscriptionStatuses)
}

function frozenChurnedResult(): ChurnResult {
  return { churn_risk_score: null, churn_risk_band: 'churned', risk_signals_triggered: [], risk_signals_evaluated: 0 }
}

describe('D-NEXT — churned account state, decoupled from mrr_cents (2026-08-04)', () => {
  it('a churned account is detected when the (only) subscription is canceled', () => {
    expect(isChurned(['canceled'])).toBe(true)
  })

  it('all subscriptions canceled across a multi-sub account is churned', () => {
    expect(isChurned(['canceled', 'canceled'])).toBe(true)
  })

  it('an active account with positive MRR and no canceled subscription is not churned', () => {
    expect(isChurned(['active'])).toBe(false)
  })

  it('REGRESSION (audit point 6): a past_due account is NOT churned, even though it may be at mrr_cents=0 for other reasons — it is delinquent, not gone', () => {
    expect(isChurned(['past_due'])).toBe(false)
  })

  it('REGRESSION: an unpaid account is NOT churned', () => {
    expect(isChurned(['unpaid'])).toBe(false)
  })

  it('REGRESSION (audit point 20a): a compte invoice-only, sans aucune subscription, is NOT churned by default (no data ≠ neutral data — not "the customer left")', () => {
    expect(isChurned([])).toBe(false)
  })

  it('a mixed account with one active and one canceled subscription is not churned (at least one live subscription)', () => {
    expect(isChurned(['active', 'canceled'])).toBe(false)
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
