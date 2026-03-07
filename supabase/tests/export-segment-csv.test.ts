import { describe, it, expect } from 'vitest'
import {
  buildSegmentCsv,
  convertMrrCentsToEur,
  SEGMENT_CSV_COLUMNS,
  type SegmentAccountRow,
} from '../functions/_shared/segment-export-helpers'
import {
  isValidSegment,
  isValidSortField,
  isValidSortOrder,
  VALID_SEGMENTS,
} from '../functions/_shared/validators'

// ── Helper ──────────────────────────────────────────────────

function makeRow(overrides: Partial<SegmentAccountRow> = {}): SegmentAccountRow {
  return {
    stripe_customer_id: 'cus_test123',
    hubspot_company_id: 'hub_test456',
    plan_tier: 'growth',
    billing_interval: 'monthly',
    mrr_cents: 15000,
    seat_count: 8,
    seat_limit: 10,
    contract_end_date: '2026-06-15',
    health_score: 72,
    churn_risk_score: 35,
    expansion_score: 65,
    product_usage_score: 58,
    ...overrides,
  }
}

// ── Zero-PII check ──────────────────────────────────────────

describe('Zero-PII compliance', () => {
  it('CSV never contains email, name, phone, or address fields', () => {
    const csv = buildSegmentCsv([makeRow()])
    const lower = csv.toLowerCase()
    expect(lower).not.toContain('email')
    expect(lower).not.toContain('phone')
    expect(lower).not.toContain('address')
    // Column headers should not have "name" (except segment_name-like technical fields)
    const headerLine = csv.split('\n')[1] // line after comment
    expect(headerLine).not.toContain('first_name')
    expect(headerLine).not.toContain('last_name')
    expect(headerLine).not.toContain('company_name')
  })

  it('CSV starts with Zero-PII compliance comment', () => {
    const csv = buildSegmentCsv([makeRow()])
    expect(csv.startsWith('# Sentio AI Export')).toBe(true)
    expect(csv).toContain('Zero-PII compliant')
  })
})

// ── MRR conversion ──────────────────────────────────────────

describe('convertMrrCentsToEur', () => {
  it('converts 150000 cents to "1500.00"', () => {
    expect(convertMrrCentsToEur(150000)).toBe('1500.00')
  })

  it('converts 15000 cents to "150.00"', () => {
    expect(convertMrrCentsToEur(15000)).toBe('150.00')
  })

  it('converts 99 cents to "0.99"', () => {
    expect(convertMrrCentsToEur(99)).toBe('0.99')
  })

  it('converts 0 to "0.00"', () => {
    expect(convertMrrCentsToEur(0)).toBe('0.00')
  })

  it('returns empty string for null', () => {
    expect(convertMrrCentsToEur(null)).toBe('')
  })
})

// ── CSV building ────────────────────────────────────────────

describe('buildSegmentCsv', () => {
  it('has correct column count (12 columns)', () => {
    expect(SEGMENT_CSV_COLUMNS.length).toBe(12)
  })

  it('produces header + comment + data rows', () => {
    const csv = buildSegmentCsv([makeRow(), makeRow()])
    const lines = csv.trim().split('\n')
    // line 0: comment, line 1: header, lines 2-3: data
    expect(lines.length).toBe(4)
  })

  it('converts mrr_cents to mrr_eur in CSV', () => {
    const csv = buildSegmentCsv([makeRow({ mrr_cents: 150000 })])
    const dataLine = csv.trim().split('\n')[2]
    expect(dataLine).toContain('1500.00')
  })

  it('handles null values as empty strings', () => {
    const csv = buildSegmentCsv([makeRow({
      hubspot_company_id: null,
      plan_tier: null,
      mrr_cents: null,
      seat_count: null,
      health_score: null,
    })])
    const dataLine = csv.trim().split('\n')[2]
    const fields = dataLine.split(',')
    // hubspot_company_id (index 1) should be empty
    expect(fields[1]).toBe('')
    // plan_tier (index 2) should be empty
    expect(fields[2]).toBe('')
    // mrr_eur (index 4) should be empty
    expect(fields[4]).toBe('')
  })

  it('escapes commas in values', () => {
    const csv = buildSegmentCsv([makeRow({ plan_tier: 'growth,enterprise' })])
    const dataLine = csv.trim().split('\n')[2]
    expect(dataLine).toContain('"growth,enterprise"')
  })

  it('escapes double quotes in values', () => {
    const csv = buildSegmentCsv([makeRow({ plan_tier: 'tier "pro"' })])
    const dataLine = csv.trim().split('\n')[2]
    expect(dataLine).toContain('"tier ""pro"""')
  })

  it('produces empty CSV (header only) for zero accounts', () => {
    const csv = buildSegmentCsv([])
    const lines = csv.trim().split('\n')
    expect(lines.length).toBe(2) // comment + header
  })

  it('row count matches input length', () => {
    const accounts = [makeRow(), makeRow(), makeRow()]
    const csv = buildSegmentCsv(accounts)
    const lines = csv.trim().split('\n')
    // comment + header + 3 data lines
    expect(lines.length - 2).toBe(accounts.length)
  })
})

// ── Validators ──────────────────────────────────────────────

describe('isValidSegment', () => {
  it('accepts all 8 valid segments', () => {
    for (const seg of VALID_SEGMENTS) {
      expect(isValidSegment(seg)).toBe(true)
    }
  })

  it('rejects invalid segment', () => {
    expect(isValidSegment('invalid')).toBe(false)
    expect(isValidSegment('')).toBe(false)
    expect(isValidSegment('Champions')).toBe(false) // case sensitive
  })

  it('uses correct segment names from codebase', () => {
    // Verify codebase naming (a_risque_leger, en_danger_critique)
    expect(isValidSegment('a_risque_leger')).toBe(true)
    expect(isValidSegment('en_danger_critique')).toBe(true)
    // Reject alternative naming
    expect(isValidSegment('risque_leger')).toBe(false)
    expect(isValidSegment('danger_critique')).toBe(false)
  })
})

describe('isValidSortField', () => {
  it('accepts valid sort fields', () => {
    expect(isValidSortField('mrr_cents')).toBe(true)
    expect(isValidSortField('health_score')).toBe(true)
    expect(isValidSortField('churn_risk_score')).toBe(true)
    expect(isValidSortField('expansion_score')).toBe(true)
  })

  it('rejects invalid sort fields', () => {
    expect(isValidSortField('name')).toBe(false)
    expect(isValidSortField('')).toBe(false)
  })
})

describe('isValidSortOrder', () => {
  it('accepts asc and desc', () => {
    expect(isValidSortOrder('asc')).toBe(true)
    expect(isValidSortOrder('desc')).toBe(true)
  })

  it('rejects invalid sort orders', () => {
    expect(isValidSortOrder('ASC')).toBe(false)
    expect(isValidSortOrder('')).toBe(false)
  })
})
