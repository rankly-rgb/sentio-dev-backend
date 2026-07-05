import { describe, it, expect } from 'vitest'

// ── Fonctions miroir (insights-crud/index.ts) ──────────────────

const VALID_INSIGHT_TYPES = ['churn_prediction', 'expansion_opportunity', 'renewal_alert', 'payment_risk', 'usage_drop', 'account_health_summary'] as const
const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const
const VALID_STATUSES = ['active', 'acknowledged', 'resolved', 'dismissed'] as const

function parseLimit(raw: string | null): number {
  const n = parseInt(raw ?? '20', 10)
  if (!Number.isFinite(n) || n < 1) return 20
  return Math.min(100, n)
}

function parseOffset(raw: string | null): number {
  const n = parseInt(raw ?? '0', 10)
  if (!Number.isFinite(n) || n < 0) return 0
  return n
}

function parseCsvFilter<T extends string>(raw: string | null, valid: readonly T[]): T[] | null {
  if (!raw) return null
  const values = raw.split(',').filter((v): v is T => (valid as readonly string[]).includes(v))
  return values.length > 0 ? values : null
}

// ── Tests ───────────────────────────────────────────────────

describe('parseLimit', () => {
  it('defaults to 20 when absent', () => {
    expect(parseLimit(null)).toBe(20)
  })

  it('parses a valid value', () => {
    expect(parseLimit('50')).toBe(50)
  })

  it('clamps above 100 down to 100', () => {
    expect(parseLimit('500')).toBe(100)
  })

  it('falls back to 20 for zero or negative', () => {
    expect(parseLimit('0')).toBe(20)
    expect(parseLimit('-5')).toBe(20)
  })

  it('falls back to 20 for non-numeric input', () => {
    expect(parseLimit('abc')).toBe(20)
  })
})

describe('parseOffset', () => {
  it('defaults to 0 when absent', () => {
    expect(parseOffset(null)).toBe(0)
  })

  it('parses a valid value', () => {
    expect(parseOffset('40')).toBe(40)
  })

  it('falls back to 0 for negative input', () => {
    expect(parseOffset('-1')).toBe(0)
  })

  it('falls back to 0 for non-numeric input', () => {
    expect(parseOffset('abc')).toBe(0)
  })
})

describe('parseCsvFilter', () => {
  it('returns null when absent', () => {
    expect(parseCsvFilter(null, VALID_STATUSES)).toBeNull()
  })

  it('parses a single valid value', () => {
    expect(parseCsvFilter('active', VALID_STATUSES)).toEqual(['active'])
  })

  it('parses multiple valid CSV values', () => {
    expect(parseCsvFilter('active,resolved', VALID_STATUSES)).toEqual(['active', 'resolved'])
  })

  it('drops invalid values, keeping only valid ones', () => {
    expect(parseCsvFilter('active,bogus', VALID_STATUSES)).toEqual(['active'])
  })

  it('returns null when every value is invalid', () => {
    expect(parseCsvFilter('bogus', VALID_STATUSES)).toBeNull()
  })

  it('works for insight_type and priority filters too', () => {
    expect(parseCsvFilter('churn_prediction,payment_risk', VALID_INSIGHT_TYPES)).toEqual(['churn_prediction', 'payment_risk'])
    expect(parseCsvFilter('critical,high', VALID_PRIORITIES)).toEqual(['critical', 'high'])
  })
})
