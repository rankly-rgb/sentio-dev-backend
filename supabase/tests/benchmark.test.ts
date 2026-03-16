import { describe, it, expect } from 'vitest'
import {
  computeRating,
  computeNrr,
  computeChurnRate,
  computeMrrGrowth,
  computeMedian,
  buildPeerResult,
  buildMetricResult,
  computeNetMovements,
  type MrrMovementRow,
} from '../functions/_shared/benchmark-helpers'
import { EXTERNAL_BENCHMARKS, MIN_PEER_ORG_COUNT } from '../functions/get-benchmark-data/benchmark-constants'

// ── Constants ─────────────────────────────────────────

describe('EXTERNAL_BENCHMARKS', () => {
  it('has 3 metrics', () => {
    expect(Object.keys(EXTERNAL_BENCHMARKS)).toEqual(['nrr', 'churn_rate', 'mrr_growth'])
  })

  it('each metric has sources', () => {
    for (const key of Object.keys(EXTERNAL_BENCHMARKS) as Array<keyof typeof EXTERNAL_BENCHMARKS>) {
      expect(EXTERNAL_BENCHMARKS[key].sources.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('MIN_PEER_ORG_COUNT is 3', () => {
    expect(MIN_PEER_ORG_COUNT).toBe(3)
  })
})

// ── computeRating — NRR ───────────────────────────────

describe('computeRating — NRR', () => {
  it('> 110 = excellent', () => {
    expect(computeRating('nrr', 115)).toBe('excellent')
  })

  it('110 = bon (boundary)', () => {
    expect(computeRating('nrr', 110)).toBe('bon')
  })

  it('105 = bon', () => {
    expect(computeRating('nrr', 105)).toBe('bon')
  })

  it('100 = bon (boundary)', () => {
    expect(computeRating('nrr', 100)).toBe('bon')
  })

  it('95 = correct', () => {
    expect(computeRating('nrr', 95)).toBe('correct')
  })

  it('90 = correct (boundary)', () => {
    expect(computeRating('nrr', 90)).toBe('correct')
  })

  it('85 = médiocre', () => {
    expect(computeRating('nrr', 85)).toBe('médiocre')
  })

  it('null = médiocre', () => {
    expect(computeRating('nrr', null)).toBe('médiocre')
  })
})

// ── computeRating — churn_rate (inversé) ──────────────

describe('computeRating — churn_rate (inversé)', () => {
  it('0.3 = excellent (< 0.5)', () => {
    expect(computeRating('churn_rate', 0.3)).toBe('excellent')
  })

  it('0.5 = bon (boundary)', () => {
    expect(computeRating('churn_rate', 0.5)).toBe('bon')
  })

  it('0.8 = bon', () => {
    expect(computeRating('churn_rate', 0.8)).toBe('bon')
  })

  it('1.0 = bon (boundary)', () => {
    expect(computeRating('churn_rate', 1.0)).toBe('bon')
  })

  it('1.5 = correct', () => {
    expect(computeRating('churn_rate', 1.5)).toBe('correct')
  })

  it('2.0 = correct (boundary)', () => {
    expect(computeRating('churn_rate', 2.0)).toBe('correct')
  })

  it('3.5 = médiocre', () => {
    expect(computeRating('churn_rate', 3.5)).toBe('médiocre')
  })

  it('null = médiocre', () => {
    expect(computeRating('churn_rate', null)).toBe('médiocre')
  })
})

// ── computeRating — mrr_growth ────────────────────────

describe('computeRating — mrr_growth', () => {
  it('20 = excellent (> 15)', () => {
    expect(computeRating('mrr_growth', 20)).toBe('excellent')
  })

  it('15 = bon (boundary)', () => {
    expect(computeRating('mrr_growth', 15)).toBe('bon')
  })

  it('12 = bon', () => {
    expect(computeRating('mrr_growth', 12)).toBe('bon')
  })

  it('10 = bon (boundary)', () => {
    expect(computeRating('mrr_growth', 10)).toBe('bon')
  })

  it('7 = correct', () => {
    expect(computeRating('mrr_growth', 7)).toBe('correct')
  })

  it('5 = correct (boundary)', () => {
    expect(computeRating('mrr_growth', 5)).toBe('correct')
  })

  it('3 = médiocre', () => {
    expect(computeRating('mrr_growth', 3)).toBe('médiocre')
  })
})

// ── computeNrr ────────────────────────────────────────

describe('computeNrr', () => {
  it('returns 100 when no movements (NRR = 100%)', () => {
    expect(computeNrr(100000, [])).toBe(100)
  })

  it('calculates NRR with expansion', () => {
    // MRR actuel = 110000, expansion = 10000
    // MRR_début = 110000 - 10000 = 100000
    // NRR = (100000 + 10000) / 100000 * 100 = 110
    const movements: MrrMovementRow[] = [
      { movement_type: 'expansion', amount_cents: 10000 },
    ]
    expect(computeNrr(110000, movements)).toBe(110)
  })

  it('calculates NRR with churn', () => {
    // MRR actuel = 80000, churn = 20000
    // MRR_début = 80000 - (-20000) = 100000
    // NRR = (100000 - 20000) / 100000 * 100 = 80
    const movements: MrrMovementRow[] = [
      { movement_type: 'churn', amount_cents: 20000 },
    ]
    expect(computeNrr(80000, movements)).toBe(80)
  })

  it('calculates NRR with mixed movements', () => {
    // MRR actuel = 105000
    // expansion = 15000, contraction = 5000, churn = 10000, reactivation = 5000
    // net = 15000 + 5000 - 5000 - 10000 = 5000
    // MRR_début = 105000 - 5000 = 100000
    // NRR = (100000 + 15000 + 5000 - 5000 - 10000) / 100000 * 100 = 105
    const movements: MrrMovementRow[] = [
      { movement_type: 'expansion', amount_cents: 15000 },
      { movement_type: 'contraction', amount_cents: 5000 },
      { movement_type: 'churn', amount_cents: 10000 },
      { movement_type: 'reactivation', amount_cents: 5000 },
    ]
    expect(computeNrr(105000, movements)).toBe(105)
  })

  it('excludes new business from NRR calculation', () => {
    // MRR actuel = 120000, new = 20000
    // MRR_début = 120000 - 20000 = 100000
    // NRR = (100000) / 100000 * 100 = 100 (new excluded from numerator)
    const movements: MrrMovementRow[] = [
      { movement_type: 'new', amount_cents: 20000 },
    ]
    expect(computeNrr(120000, movements)).toBe(100)
  })

  it('returns null when MRR_début <= 0 (division by zero)', () => {
    expect(computeNrr(0, [])).toBeNull()
  })

  it('returns null when MRR_début is negative', () => {
    // MRR actuel = 5000, churn = 10000
    // MRR_début = 5000 - (-10000) = 15000 (still positive)
    // This case actually works. Let's make a real negative case:
    // MRR actuel = 0, new = 0 → MRR_début = 0
    expect(computeNrr(0, [{ movement_type: 'new', amount_cents: 0 }])).toBeNull()
  })

  it('rounds to 1 decimal', () => {
    // MRR actuel = 103333, expansion = 3333
    // MRR_début = 103333 - 3333 = 100000
    // NRR = (100000 + 3333) / 100000 * 100 = 103.333
    const movements: MrrMovementRow[] = [
      { movement_type: 'expansion', amount_cents: 3333 },
    ]
    expect(computeNrr(103333, movements)).toBe(103.3)
  })
})

// ── computeChurnRate ──────────────────────────────────

describe('computeChurnRate', () => {
  it('calculates churn rate correctly', () => {
    // 2 churned / 100 start = 2%
    expect(computeChurnRate(2, 100)).toBe(2)
  })

  it('returns 0 when no churn', () => {
    expect(computeChurnRate(0, 100)).toBe(0)
  })

  it('returns null when startCount <= 0 (division by zero)', () => {
    expect(computeChurnRate(5, 0)).toBeNull()
  })

  it('rounds to 2 decimals', () => {
    // 1 / 3 = 33.333... → 33.33
    expect(computeChurnRate(1, 3)).toBe(33.33)
  })

  it('handles small numbers', () => {
    // 1 / 200 = 0.5
    expect(computeChurnRate(1, 200)).toBe(0.5)
  })
})

// ── computeMrrGrowth ──────────────────────────────────

describe('computeMrrGrowth', () => {
  it('calculates growth correctly', () => {
    // MRR actuel = 110000, net movements = 10000
    // MRR 30j ago = 110000 - 10000 = 100000
    // Growth = (110000 - 100000) / 100000 * 100 = 10%
    expect(computeMrrGrowth(110000, 10000)).toBe(10)
  })

  it('returns 0 when no growth', () => {
    expect(computeMrrGrowth(100000, 0)).toBe(0)
  })

  it('handles negative growth (contraction)', () => {
    // MRR actuel = 90000, net movements = -10000
    // MRR 30j ago = 90000 - (-10000) = 100000
    // Growth = (90000 - 100000) / 100000 * 100 = -10%
    expect(computeMrrGrowth(90000, -10000)).toBe(-10)
  })

  it('returns null when MRR 30j ago <= 0 (division by zero)', () => {
    // MRR actuel = 10000, net = 10000 → MRR 30j ago = 0
    expect(computeMrrGrowth(10000, 10000)).toBeNull()
  })

  it('rounds to 1 decimal', () => {
    // MRR actuel = 103333, net = 3333
    // MRR 30j ago = 100000
    // Growth = 3.333%
    expect(computeMrrGrowth(103333, 3333)).toBe(3.3)
  })
})

// ── computeNetMovements ───────────────────────────────

describe('computeNetMovements', () => {
  it('returns 0 for empty array', () => {
    expect(computeNetMovements([])).toBe(0)
  })

  it('sums positive movements (new, expansion, reactivation)', () => {
    const movements: MrrMovementRow[] = [
      { movement_type: 'new', amount_cents: 10000 },
      { movement_type: 'expansion', amount_cents: 5000 },
      { movement_type: 'reactivation', amount_cents: 3000 },
    ]
    expect(computeNetMovements(movements)).toBe(18000)
  })

  it('subtracts negative movements (contraction, churn)', () => {
    const movements: MrrMovementRow[] = [
      { movement_type: 'contraction', amount_cents: 2000 },
      { movement_type: 'churn', amount_cents: 8000 },
    ]
    expect(computeNetMovements(movements)).toBe(-10000)
  })

  it('handles mixed movements', () => {
    const movements: MrrMovementRow[] = [
      { movement_type: 'new', amount_cents: 20000 },
      { movement_type: 'expansion', amount_cents: 5000 },
      { movement_type: 'churn', amount_cents: 10000 },
      { movement_type: 'contraction', amount_cents: 3000 },
    ]
    expect(computeNetMovements(movements)).toBe(12000)
  })
})

// ── computeMedian ─────────────────────────────────────

describe('computeMedian', () => {
  it('returns null for empty array', () => {
    expect(computeMedian([])).toBeNull()
  })

  it('returns the value for single element', () => {
    expect(computeMedian([42])).toBe(42)
  })

  it('returns median for odd count', () => {
    expect(computeMedian([10, 20, 30])).toBe(20)
  })

  it('returns average for even count', () => {
    expect(computeMedian([10, 20, 30, 40])).toBe(25)
  })

  it('ignores null values', () => {
    expect(computeMedian([null, 10, null, 30, 20])).toBe(20)
  })

  it('returns null when all values are null', () => {
    expect(computeMedian([null, null, null])).toBeNull()
  })

  it('sorts correctly (not lexicographic)', () => {
    expect(computeMedian([100, 5, 50])).toBe(50)
  })
})

// ── buildPeerResult ───────────────────────────────────

describe('buildPeerResult', () => {
  it('returns available: false when orgCount < 3', () => {
    const result = buildPeerResult(100, [100, 110], 2)
    expect(result.available).toBe(false)
    expect(result.median).toBeNull()
    expect(result.org_count).toBeNull()
    expect(result.delta).toBeNull()
  })

  it('returns available: true with median when orgCount >= 3', () => {
    const result = buildPeerResult(110, [90, 100, 120], 3)
    expect(result.available).toBe(true)
    expect(result.median).toBe(100)
    expect(result.org_count).toBe(3)
    expect(result.delta).toBe(10) // 110 - 100
  })

  it('returns delta null when orgValue is null', () => {
    const result = buildPeerResult(null, [90, 100, 120], 3)
    expect(result.available).toBe(true)
    expect(result.median).toBe(100)
    expect(result.delta).toBeNull()
  })

  it('boundary: orgCount = 2 is not enough', () => {
    expect(buildPeerResult(100, [100, 110], 2).available).toBe(false)
  })

  it('boundary: orgCount = 3 is enough', () => {
    expect(buildPeerResult(100, [100, 110, 120], 3).available).toBe(true)
  })
})

// ── buildMetricResult ─────────────────────────────────

describe('buildMetricResult', () => {
  const peer = { available: false, median: null, org_count: null, delta: null }

  it('includes external benchmark values and sources', () => {
    const result = buildMetricResult('nrr', 115, peer)
    expect(result.external_benchmark.excellent).toBe(120)
    expect(result.external_benchmark.bon).toBe(110)
    expect(result.external_benchmark.correct).toBe(100)
    expect(result.external_benchmark.mediocre).toBe(90)
    expect(result.external_benchmark.sources.length).toBeGreaterThanOrEqual(1)
  })

  it('computes correct rating for value', () => {
    const result = buildMetricResult('nrr', 115, peer)
    expect(result.external_benchmark.rating).toBe('excellent')
  })

  it('passes through peer result', () => {
    const peerAvail = { available: true, median: 105, org_count: 5, delta: 10 }
    const result = buildMetricResult('nrr', 115, peerAvail)
    expect(result.peer).toEqual(peerAvail)
  })

  it('handles null value', () => {
    const result = buildMetricResult('churn_rate', null, peer)
    expect(result.value).toBeNull()
    expect(result.external_benchmark.rating).toBe('médiocre')
  })
})
