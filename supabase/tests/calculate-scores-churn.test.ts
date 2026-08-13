import { describe, it, expect } from 'vitest'
import { isAccountChurned } from '../functions/_shared/mrr-engine'
import { applyDelinquencyBandFloor } from '../functions/_shared/scoring'

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

// ── Mirror of the delinquency-duration-floor glue (Lot 5, 2026-08-13, #35,
// scoreAccountPure) — the duration computation and risk_signals_triggered
// injection live inline in calculate-scores/index.ts (jsr: imports, not
// resolvable by Vitest); applyDelinquencyBandFloor itself is real production
// code imported directly (zero jsr: deps), only the day-count arithmetic and
// signal-injection glue are mirrored here.

function computeDelinquentDurationDays(delinquentSince: string | null, now: number): number | null {
  return delinquentSince ? Math.floor((now - new Date(delinquentSince).getTime()) / 86400000) : null
}

function applyFloorAndInjectSignal(
  rawChurn: { churn_risk_band: 'low' | 'watch' | 'high'; risk_signals_triggered: Array<{ code: string; label: string; severity: string; points: number }> },
  isDelinquent: boolean,
  delinquentSince: string | null,
  now: number,
) {
  const delinquentDurationDays = computeDelinquentDurationDays(delinquentSince, now)
  const floor = applyDelinquencyBandFloor(rawChurn.churn_risk_band, isDelinquent, delinquentDurationDays)
  return {
    ...rawChurn,
    churn_risk_band: floor.band,
    risk_signals_triggered: floor.floor_applied
      ? [...rawChurn.risk_signals_triggered, { code: 'delinquency_duration_floor', label: floor.floor_reason ?? '', severity: 'CRITIQUE', points: 0 }]
      : rawChurn.risk_signals_triggered,
  }
}

describe('Lot 5 (2026-08-13, #35) — delinquency-duration-floor glue (scoreAccountPure mirror)', () => {
  const NOW = new Date('2026-08-13T00:00:00Z').getTime()

  it('a 60-day-delinquent account with no other signals resolves to critical — negative test', () => {
    const delinquentSince = new Date(NOW - 60 * 86400000).toISOString().split('T')[0]
    const result = applyFloorAndInjectSignal(
      { churn_risk_band: 'low', risk_signals_triggered: [] },
      true,
      delinquentSince,
      NOW,
    )
    expect(result.churn_risk_band).toBe('critical')
    expect(result.churn_risk_band).not.toBe('low')
    expect(result.churn_risk_band).not.toBe('watch')
    expect(result.churn_risk_band).not.toBe('high')
  })

  it('injects a delinquency_duration_floor signal with points:0 (never double-counted in churn_risk_score)', () => {
    const delinquentSince = new Date(NOW - 60 * 86400000).toISOString().split('T')[0]
    const result = applyFloorAndInjectSignal(
      { churn_risk_band: 'low', risk_signals_triggered: [] },
      true,
      delinquentSince,
      NOW,
    )
    const floorSignal = result.risk_signals_triggered.find((s) => s.code === 'delinquency_duration_floor')
    expect(floorSignal).toBeDefined()
    expect(floorSignal?.points).toBe(0)
    expect(floorSignal?.label).toContain('60 day(s)')
  })

  it('injects no floor signal when the raw band already satisfies the floor', () => {
    const delinquentSince = new Date(NOW - 60 * 86400000).toISOString().split('T')[0]
    const result = applyFloorAndInjectSignal(
      { churn_risk_band: 'critical' as unknown as 'high', risk_signals_triggered: [{ code: 'invoice_overdue_15d', label: 'x', severity: 'CRITIQUE', points: 35 }] },
      true,
      delinquentSince,
      NOW,
    )
    expect(result.risk_signals_triggered.some((s) => s.code === 'delinquency_duration_floor')).toBe(false)
  })

  it('a non-delinquent account is never floored, regardless of a stale delinquent_since', () => {
    const staleDelinquentSince = new Date(NOW - 90 * 86400000).toISOString().split('T')[0]
    const result = applyFloorAndInjectSignal(
      { churn_risk_band: 'low', risk_signals_triggered: [] },
      false,
      staleDelinquentSince,
      NOW,
    )
    expect(result.churn_risk_band).toBe('low')
  })

  it('a delinquent account with delinquent_since=null (unknown duration) floors to watch, not low', () => {
    const result = applyFloorAndInjectSignal(
      { churn_risk_band: 'low', risk_signals_triggered: [] },
      true,
      null,
      NOW,
    )
    expect(result.churn_risk_band).toBe('watch')
  })
})
