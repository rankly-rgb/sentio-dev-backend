import { describe, it, expect } from 'vitest'
import {
  buildSegmentCsv,
  convertMrrCentsToEur,
  SEGMENT_CSV_COLUMNS,
  SEGMENT_FILTERS,
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
  const base: SegmentAccountRow = {
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
    created_at: '2025-01-15T00:00:00Z',
    data_source: 'stripe',
  }
  return Object.assign(base, overrides)
}

/** HubSpot-only account (no stripe_customer_id) */
function makeHubspotRow(overrides: Partial<SegmentAccountRow> = {}): SegmentAccountRow {
  return makeRow({
    stripe_customer_id: null,
    hubspot_company_id: 'hub_test456',
    plan_tier: null,
    billing_interval: null,
    mrr_cents: null,
    seat_count: null,
    seat_limit: null,
    contract_end_date: null,
    data_source: 'hubspot',
    ...overrides,
  })
}

// ── Zero-PII check ──────────────────────────────────────────

describe('Zero-PII compliance', () => {
  it('CSV never contains email, name, phone, or address fields', () => {
    const csv = buildSegmentCsv([makeRow()])
    const lower = csv.toLowerCase()
    expect(lower).not.toContain('email')
    expect(lower).not.toContain('phone')
    expect(lower).not.toContain('address')
    const headerLine = csv.split('\n')[0].replace(/^\uFEFF/, '') // skip BOM
    expect(headerLine).not.toContain('first_name')
    expect(headerLine).not.toContain('last_name')
    expect(headerLine).not.toContain('company_name')
  })
})

// ── BOM UTF-8 ───────────────────────────────────────────────

describe('BOM UTF-8', () => {
  it('CSV starts with UTF-8 BOM for Excel FR compatibility', () => {
    const csv = buildSegmentCsv([makeRow()])
    expect(csv.charCodeAt(0)).toBe(0xFEFF)
  })

  it('first line after BOM is the column header', () => {
    const csv = buildSegmentCsv([makeRow()])
    const firstLine = csv.replace(/^\uFEFF/, '').split('\n')[0]
    expect(firstLine).toBe(SEGMENT_CSV_COLUMNS.join(','))
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

  it('produces header + data rows (no comment line)', () => {
    const csv = buildSegmentCsv([makeRow(), makeRow()])
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\n')
    // line 0: header, lines 1-2: data
    expect(lines.length).toBe(3)
  })

  it('converts mrr_cents to mrr_eur in CSV', () => {
    const csv = buildSegmentCsv([makeRow({ mrr_cents: 150000 })])
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\n')
    expect(lines[1]).toContain('1500.00')
  })

  it('handles null values as empty strings', () => {
    const csv = buildSegmentCsv([makeRow({
      hubspot_company_id: null,
      plan_tier: null,
      mrr_cents: null,
      seat_count: null,
      health_score: null,
    })])
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\n')
    const fields = lines[1].split(',')
    expect(fields[1]).toBe('') // hubspot_company_id
    expect(fields[2]).toBe('') // plan_tier
    expect(fields[4]).toBe('') // mrr_eur
  })

  it('escapes commas in values', () => {
    const csv = buildSegmentCsv([makeRow({ plan_tier: 'growth,enterprise' })])
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\n')
    expect(lines[1]).toContain('"growth,enterprise"')
  })

  it('escapes double quotes in values', () => {
    const csv = buildSegmentCsv([makeRow({ plan_tier: 'tier "pro"' })])
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\n')
    expect(lines[1]).toContain('"tier ""pro"""')
  })

  it('produces empty CSV (header only) for zero accounts', () => {
    const csv = buildSegmentCsv([])
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\n')
    expect(lines.length).toBe(1) // header only
  })

  it('row count matches input length', () => {
    const accounts = [makeRow(), makeRow(), makeRow()]
    const csv = buildSegmentCsv(accounts)
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\n')
    // header + 3 data lines
    expect(lines.length - 1).toBe(accounts.length)
  })
})

// ── Segment Filters (aligned with scoring.ts determineSegmentTypes) ──

describe('SEGMENT_FILTERS', () => {
  it('has a filter for each valid segment', () => {
    for (const seg of VALID_SEGMENTS) {
      expect(typeof SEGMENT_FILTERS[seg]).toBe('function')
    }
  })

  describe('champions — health >= 80 AND churn_risk < 50', () => {
    it('matches health = 80 (boundary inclusive)', () => {
      expect(SEGMENT_FILTERS.champions(makeRow({ health_score: 80, churn_risk_score: 20 }))).toBe(true)
    })
    it('matches health = 95', () => {
      expect(SEGMENT_FILTERS.champions(makeRow({ health_score: 95, churn_risk_score: 10 }))).toBe(true)
    })
    it('rejects health = 79', () => {
      expect(SEGMENT_FILTERS.champions(makeRow({ health_score: 79, churn_risk_score: 10 }))).toBe(false)
    })
    it('rejects churn_risk = 50 (a_risque_leger territory)', () => {
      expect(SEGMENT_FILTERS.champions(makeRow({ health_score: 90, churn_risk_score: 50 }))).toBe(false)
    })
  })

  describe('en_expansion — expansion >= 70 AND health 60-79 AND churn < 50', () => {
    it('matches expansion = 70, health = 60', () => {
      expect(SEGMENT_FILTERS.en_expansion(makeRow({ expansion_score: 70, health_score: 60, churn_risk_score: 20 }))).toBe(true)
    })
    it('rejects health >= 80 (champions territory)', () => {
      expect(SEGMENT_FILTERS.en_expansion(makeRow({ expansion_score: 80, health_score: 85, churn_risk_score: 20 }))).toBe(false)
    })
    it('rejects expansion = 69', () => {
      expect(SEGMENT_FILTERS.en_expansion(makeRow({ expansion_score: 69, health_score: 65, churn_risk_score: 20 }))).toBe(false)
    })
    it('rejects churn_risk >= 50', () => {
      expect(SEGMENT_FILTERS.en_expansion(makeRow({ expansion_score: 80, health_score: 65, churn_risk_score: 50 }))).toBe(false)
    })
  })

  describe('stables — default fallback (mrr > 0, churn < 50, health < 80, not en_expansion)', () => {
    it('matches typical stable account', () => {
      expect(SEGMENT_FILTERS.stables(makeRow({ health_score: 70, churn_risk_score: 20, expansion_score: 50, mrr_cents: 10000 }))).toBe(true)
    })
    it('rejects health >= 80 (champions)', () => {
      expect(SEGMENT_FILTERS.stables(makeRow({ health_score: 80, churn_risk_score: 20, mrr_cents: 10000 }))).toBe(false)
    })
    it('rejects churn_risk >= 50 (a_risque_leger)', () => {
      expect(SEGMENT_FILTERS.stables(makeRow({ health_score: 60, churn_risk_score: 50, mrr_cents: 10000 }))).toBe(false)
    })
    it('rejects mrr = 0 (en_churn)', () => {
      expect(SEGMENT_FILTERS.stables(makeRow({ health_score: 60, churn_risk_score: 20, mrr_cents: 0 }))).toBe(false)
    })
    it('rejects en_expansion conditions (expansion >= 70, health >= 60)', () => {
      expect(SEGMENT_FILTERS.stables(makeRow({ health_score: 65, churn_risk_score: 20, expansion_score: 75, mrr_cents: 10000 }))).toBe(false)
    })
  })

  describe('a_risque_leger — churn_risk 50-69 AND mrr > 0', () => {
    it('matches churn_risk = 50 (boundary inclusive)', () => {
      expect(SEGMENT_FILTERS.a_risque_leger(makeRow({ churn_risk_score: 50, mrr_cents: 10000 }))).toBe(true)
    })
    it('matches churn_risk = 69', () => {
      expect(SEGMENT_FILTERS.a_risque_leger(makeRow({ churn_risk_score: 69, mrr_cents: 10000 }))).toBe(true)
    })
    it('rejects churn_risk = 70 (en_danger_critique)', () => {
      expect(SEGMENT_FILTERS.a_risque_leger(makeRow({ churn_risk_score: 70, mrr_cents: 10000 }))).toBe(false)
    })
    it('rejects churn_risk = 49', () => {
      expect(SEGMENT_FILTERS.a_risque_leger(makeRow({ churn_risk_score: 49, mrr_cents: 10000 }))).toBe(false)
    })
    it('rejects mrr = 0', () => {
      expect(SEGMENT_FILTERS.a_risque_leger(makeRow({ churn_risk_score: 55, mrr_cents: 0 }))).toBe(false)
    })
  })

  describe('en_danger_critique — churn_risk >= 70 AND mrr > 0', () => {
    it('matches churn_risk = 70 (boundary inclusive)', () => {
      expect(SEGMENT_FILTERS.en_danger_critique(makeRow({ churn_risk_score: 70, mrr_cents: 10000 }))).toBe(true)
    })
    it('matches churn_risk = 95', () => {
      expect(SEGMENT_FILTERS.en_danger_critique(makeRow({ churn_risk_score: 95, mrr_cents: 5000 }))).toBe(true)
    })
    it('rejects churn_risk = 69', () => {
      expect(SEGMENT_FILTERS.en_danger_critique(makeRow({ churn_risk_score: 69, mrr_cents: 10000 }))).toBe(false)
    })
    it('rejects mrr = 0 (en_churn territory)', () => {
      expect(SEGMENT_FILTERS.en_danger_critique(makeRow({ churn_risk_score: 85, mrr_cents: 0 }))).toBe(false)
    })
  })

  describe('impayes — score proxy (churn > 80 AND health < 50 AND mrr > 0)', () => {
    it('matches churn_risk > 80 AND health < 50 AND mrr > 0', () => {
      expect(SEGMENT_FILTERS.impayes(makeRow({ churn_risk_score: 85, health_score: 40, mrr_cents: 10000 }))).toBe(true)
    })
    it('rejects churn_risk = 80', () => {
      expect(SEGMENT_FILTERS.impayes(makeRow({ churn_risk_score: 80, health_score: 40, mrr_cents: 10000 }))).toBe(false)
    })
    it('rejects health = 50', () => {
      expect(SEGMENT_FILTERS.impayes(makeRow({ churn_risk_score: 85, health_score: 50, mrr_cents: 10000 }))).toBe(false)
    })
    it('rejects mrr = 0 (en_churn territory)', () => {
      expect(SEGMENT_FILTERS.impayes(makeRow({ churn_risk_score: 85, health_score: 40, mrr_cents: 0 }))).toBe(false)
    })
  })

  describe('en_churn — mrr_cents = 0 (aligned with scoring.ts)', () => {
    it('matches mrr_cents = 0', () => {
      expect(SEGMENT_FILTERS.en_churn(makeRow({ mrr_cents: 0 }))).toBe(true)
    })
    it('matches mrr_cents = null (treated as 0)', () => {
      expect(SEGMENT_FILTERS.en_churn(makeRow({ mrr_cents: null }))).toBe(true)
    })
    it('rejects mrr_cents = 1 (any positive MRR)', () => {
      expect(SEGMENT_FILTERS.en_churn(makeRow({ mrr_cents: 1 }))).toBe(false)
    })
    it('rejects mrr_cents = 15000', () => {
      expect(SEGMENT_FILTERS.en_churn(makeRow({ mrr_cents: 15000 }))).toBe(false)
    })
  })

  describe('nouveaux', () => {
    it('matches account created less than 90 days ago', () => {
      const recent = new Date()
      recent.setDate(recent.getDate() - 30)
      expect(SEGMENT_FILTERS.nouveaux(makeRow({ created_at: recent.toISOString() }))).toBe(true)
    })
    it('rejects account created more than 90 days ago', () => {
      const old = new Date()
      old.setDate(old.getDate() - 100)
      expect(SEGMENT_FILTERS.nouveaux(makeRow({ created_at: old.toISOString() }))).toBe(false)
    })
    it('rejects null created_at', () => {
      expect(SEGMENT_FILTERS.nouveaux(makeRow({ created_at: null }))).toBe(false)
    })
  })

  describe('null score handling', () => {
    it('treats null health as 0 for champions (rejected)', () => {
      expect(SEGMENT_FILTERS.champions(makeRow({ health_score: null }))).toBe(false)
    })
    it('treats null mrr as 0 for en_churn (matched)', () => {
      expect(SEGMENT_FILTERS.en_churn(makeRow({ mrr_cents: null }))).toBe(true)
    })
    it('treats null churn_risk as 0 for stables (eligible)', () => {
      expect(SEGMENT_FILTERS.stables(makeRow({ churn_risk_score: null, health_score: 60, mrr_cents: 10000, expansion_score: 30 }))).toBe(true)
    })
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
    expect(isValidSegment('Champions')).toBe(false)
  })

  it('uses correct segment names from codebase', () => {
    expect(isValidSegment('a_risque_leger')).toBe(true)
    expect(isValidSegment('en_danger_critique')).toBe(true)
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

// ── SEGMENT_FILTERS — HubSpot-only accounts ────────────────

describe('SEGMENT_FILTERS — HubSpot-only (no stripe_customer_id)', () => {
  it('en_churn rejects HubSpot-only accounts (no MRR data)', () => {
    expect(SEGMENT_FILTERS.en_churn(makeHubspotRow({ mrr_cents: null }))).toBe(false)
    expect(SEGMENT_FILTERS.en_churn(makeHubspotRow({ mrr_cents: 0 }))).toBe(false)
  })

  it('impayes rejects HubSpot-only accounts', () => {
    expect(SEGMENT_FILTERS.impayes(makeHubspotRow({ churn_risk_score: 85, health_score: 40 }))).toBe(false)
  })

  it('champions matches HubSpot-only with high health', () => {
    expect(SEGMENT_FILTERS.champions(makeHubspotRow({ health_score: 85, churn_risk_score: 10 }))).toBe(true)
  })

  it('en_danger_critique matches HubSpot-only with high churn risk', () => {
    expect(SEGMENT_FILTERS.en_danger_critique(makeHubspotRow({ churn_risk_score: 75 }))).toBe(true)
  })

  it('a_risque_leger matches HubSpot-only without MRR check', () => {
    expect(SEGMENT_FILTERS.a_risque_leger(makeHubspotRow({ churn_risk_score: 55 }))).toBe(true)
  })

  it('stables matches HubSpot-only without MRR check', () => {
    expect(SEGMENT_FILTERS.stables(makeHubspotRow({ health_score: 60, churn_risk_score: 20, expansion_score: 30 }))).toBe(true)
  })

  it('stables still rejects Stripe accounts with mrr = 0', () => {
    expect(SEGMENT_FILTERS.stables(makeRow({ health_score: 60, churn_risk_score: 20, mrr_cents: 0, expansion_score: 30 }))).toBe(false)
  })

  it('en_expansion matches HubSpot-only with good scores', () => {
    expect(SEGMENT_FILTERS.en_expansion(makeHubspotRow({ expansion_score: 75, health_score: 65, churn_risk_score: 20 }))).toBe(true)
  })

  it('nouveaux matches HubSpot-only with recent created_at', () => {
    const recent = new Date()
    recent.setDate(recent.getDate() - 30)
    expect(SEGMENT_FILTERS.nouveaux(makeHubspotRow({ created_at: recent.toISOString() }))).toBe(true)
  })
})
