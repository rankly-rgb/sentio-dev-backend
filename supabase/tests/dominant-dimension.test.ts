import { describe, it, expect } from 'vitest'

// ── Mirror (dashboard-api/index.ts) ────────────────────────────
// dashboard-api importe 'jsr:@supabase/functions-js/edge-runtime.d.ts' au
// niveau module (Deno-only) — non résolvable par vitest/node, donc la
// fonction pure est mirrorée ici, comme churn-alert.test.ts /
// weekly-digest.test.ts le font déjà pour ce fichier.

type Dimension = 'payment_health' | 'revenue_dynamics' | 'contract_renewal'

function dominantDimension(
  now: Record<string, number | null>,
  before: Record<string, number | null>,
): Dimension | null {
  const pairs: Array<[Dimension, number | null, number | null]> = [
    ['payment_health', now.payment_health_score, before.payment_health_score],
    ['revenue_dynamics', now.revenue_dynamics_score, before.revenue_dynamics_score],
    ['contract_renewal', now.contract_renewal_score, before.contract_renewal_score],
  ]

  const deltas = pairs
    .filter((p): p is [Dimension, number, number] => p[1] !== null && p[2] !== null)
    .map(([dim, n, b]) => [dim, Math.abs(n - b)] as [Dimension, number])

  if (deltas.length === 0) return null
  deltas.sort(([, a], [, b]) => b - a)
  return deltas[0][0]
}

// ── Tests ─────────────────────────────────────────────────────

describe('dominantDimension', () => {
  it('returns the dimension with the largest delta when all 3 dimensions are present', () => {
    const now = { payment_health_score: 60, revenue_dynamics_score: 70, contract_renewal_score: 50 }
    const before = { payment_health_score: 65, revenue_dynamics_score: 40, contract_renewal_score: 48 }
    // deltas: payment_health=5, revenue_dynamics=30, contract_renewal=2
    expect(dominantDimension(now, before)).toBe('revenue_dynamics')
  })

  it('picks the correct dimension even when the largest delta is on payment_health', () => {
    const now = { payment_health_score: 20, revenue_dynamics_score: 70, contract_renewal_score: 50 }
    const before = { payment_health_score: 90, revenue_dynamics_score: 72, contract_renewal_score: 51 }
    // deltas: payment_health=70, revenue_dynamics=2, contract_renewal=1
    expect(dominantDimension(now, before)).toBe('payment_health')
  })

  it('picks the correct dimension even when the largest delta is on contract_renewal', () => {
    const now = { payment_health_score: 60, revenue_dynamics_score: 70, contract_renewal_score: 10 }
    const before = { payment_health_score: 61, revenue_dynamics_score: 71, contract_renewal_score: 90 }
    // deltas: payment_health=1, revenue_dynamics=1, contract_renewal=80
    expect(dominantDimension(now, before)).toBe('contract_renewal')
  })

  it('excludes a dimension that is null on the "now" side and compares only the remaining two', () => {
    const now = { payment_health_score: null, revenue_dynamics_score: 55, contract_renewal_score: 50 }
    const before = { payment_health_score: 40, revenue_dynamics_score: 50, contract_renewal_score: 48 }
    // payment_health excluded (null now) even though it would have the largest
    // "delta" if fabricated; only revenue_dynamics(5) and contract_renewal(2) compared
    expect(dominantDimension(now, before)).toBe('revenue_dynamics')
  })

  it('excludes a dimension that is null on the "before" side', () => {
    const now = { payment_health_score: 60, revenue_dynamics_score: 55, contract_renewal_score: 50 }
    const before = { payment_health_score: 60, revenue_dynamics_score: null, contract_renewal_score: 20 }
    // revenue_dynamics excluded (null before); only payment_health(0) and contract_renewal(30) compared
    expect(dominantDimension(now, before)).toBe('contract_renewal')
  })

  it('returns null when every dimension is null on at least one side (nothing comparable)', () => {
    const now = { payment_health_score: null, revenue_dynamics_score: null, contract_renewal_score: null }
    const before = { payment_health_score: 60, revenue_dynamics_score: 70, contract_renewal_score: 50 }
    expect(dominantDimension(now, before)).toBeNull()
  })

  it('returns null when both sides have every dimension null', () => {
    const now = { payment_health_score: null, revenue_dynamics_score: null, contract_renewal_score: null }
    const before = { payment_health_score: null, revenue_dynamics_score: null, contract_renewal_score: null }
    expect(dominantDimension(now, before)).toBeNull()
  })

  it('never fabricates a delta using a 50/0 fallback for a missing dimension (S1)', () => {
    // If the old ??50/??0 defaults were still in place, payment_health would
    // compute a fake delta of |0 - 50| = 50 and incorrectly win. With the
    // null-exclusion fix, payment_health is dropped entirely.
    const now = { payment_health_score: null, revenue_dynamics_score: 51, contract_renewal_score: 50 }
    const before = { payment_health_score: 0, revenue_dynamics_score: 50, contract_renewal_score: 49 }
    expect(dominantDimension(now, before)).not.toBe('payment_health')
  })
})
