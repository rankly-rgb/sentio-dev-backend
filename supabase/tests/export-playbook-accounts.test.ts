import { describe, it, expect } from 'vitest'
import {
  computePriority,
  computeDaysToRenewal,
  buildTriggerReason,
  buildHubspotImportNote,
  sortAccounts,
  buildCsv,
  type AccountRow,
} from '../functions/_shared/export-helpers'

// ── computePriority ─────────────────────────────────────────

describe('computePriority', () => {
  it('returns P0 when churn_risk >= 70 AND days_to_renewal < 30', () => {
    expect(computePriority(75, 15)).toBe('P0')
    expect(computePriority(70, 0)).toBe('P0')
    expect(computePriority(100, 29)).toBe('P0')
  })

  it('returns P1 when churn_risk >= 70 but days_to_renewal >= 30', () => {
    expect(computePriority(75, 30)).toBe('P1')
    expect(computePriority(80, 60)).toBe('P1')
  })

  it('returns P1 when churn_risk >= 50 but < 70 (regardless of renewal)', () => {
    expect(computePriority(50, null)).toBe('P1')
    expect(computePriority(65, 90)).toBe('P1')
    expect(computePriority(50, 10)).toBe('P1')
  })

  it('returns P1 when days_to_renewal < 60 even with low churn', () => {
    expect(computePriority(20, 30)).toBe('P1')
    expect(computePriority(0, 59)).toBe('P1')
  })

  it('returns P2 when churn_risk < 50 AND (no renewal or renewal >= 60)', () => {
    expect(computePriority(49, null)).toBe('P2')
    expect(computePriority(30, 90)).toBe('P2')
    expect(computePriority(0, 60)).toBe('P2')
    expect(computePriority(null, null)).toBe('P2')
  })

  it('handles null churn_risk (treated as 0)', () => {
    expect(computePriority(null, 10)).toBe('P1') // days_to_renewal < 60
    expect(computePriority(null, 90)).toBe('P2')
  })

  // Edge case: boundary values
  it('P0 boundary: exactly 70 risk and 29 days', () => {
    expect(computePriority(70, 29)).toBe('P0')
  })

  it('P1 boundary: exactly 50 risk', () => {
    expect(computePriority(50, 100)).toBe('P1')
  })

  it('P2 boundary: 49 risk and 60 days', () => {
    expect(computePriority(49, 60)).toBe('P2')
  })
})

// ── computeDaysToRenewal ────────────────────────────────────

describe('computeDaysToRenewal', () => {
  it('returns null for monthly billing', () => {
    expect(computeDaysToRenewal('2026-12-31', 'monthly')).toBeNull()
  })

  it('returns null when contract_end_date is null', () => {
    expect(computeDaysToRenewal(null, 'annual')).toBeNull()
  })

  it('returns positive days for future date with annual billing', () => {
    const futureDate = new Date()
    futureDate.setDate(futureDate.getDate() + 30)
    const result = computeDaysToRenewal(futureDate.toISOString().slice(0, 10), 'annual')
    expect(result).toBeGreaterThanOrEqual(29)
    expect(result).toBeLessThanOrEqual(31)
  })

  it('returns negative days for past date', () => {
    const pastDate = new Date()
    pastDate.setDate(pastDate.getDate() - 10)
    const result = computeDaysToRenewal(pastDate.toISOString().slice(0, 10), 'annual')
    expect(result).toBeLessThanOrEqual(0)
  })
})

// ── buildTriggerReason ──────────────────────────────────────

describe('buildTriggerReason', () => {
  const baseSignals = {
    hasUnpaidInvoice: false,
    unpaidDays: null as number | null,
    loginDecline: false,
    lastLoginDaysAgo: null as number | null,
    daysToRenewal: null as number | null,
    churnRisk: null as number | null,
    healthScore: null as number | null,
  }

  it('returns default message when no signals are active', () => {
    expect(buildTriggerReason(baseSignals)).toBe('Aucun signal actif')
  })

  it('includes unpaid invoice signal', () => {
    const result = buildTriggerReason({ ...baseSignals, hasUnpaidInvoice: true, unpaidDays: 18 })
    expect(result).toContain('Invoice impayee depuis 18j')
  })

  it('includes login decline signal (lastLoginDaysAgo > 14)', () => {
    const result = buildTriggerReason({ ...baseSignals, lastLoginDaysAgo: 20 })
    expect(result).toContain('Logins en baisse')
  })

  it('includes renewal signal (daysToRenewal <= 30)', () => {
    const result = buildTriggerReason({ ...baseSignals, daysToRenewal: 8 })
    expect(result).toContain('Renouvellement dans 8j')
  })

  it('includes churn risk signal (>= 70)', () => {
    const result = buildTriggerReason({ ...baseSignals, churnRisk: 85 })
    expect(result).toContain('Risque churn critique (85/100)')
  })

  it('includes health score signal (< 40)', () => {
    const result = buildTriggerReason({ ...baseSignals, healthScore: 32 })
    expect(result).toContain('Score sante faible (32/100)')
  })

  it('combines exactly 2 signals with separator', () => {
    const result = buildTriggerReason({
      ...baseSignals,
      hasUnpaidInvoice: true,
      unpaidDays: 5,
      daysToRenewal: 10,
    })
    const parts = result.split(' · ')
    expect(parts).toHaveLength(2)
    expect(parts[0]).toContain('Invoice impayee')
    expect(parts[1]).toContain('Renouvellement')
  })

  it('combines 3 signals with separator', () => {
    const result = buildTriggerReason({
      ...baseSignals,
      hasUnpaidInvoice: true,
      unpaidDays: 18,
      lastLoginDaysAgo: 20,
      daysToRenewal: 8,
    })
    const parts = result.split(' · ')
    expect(parts).toHaveLength(3)
  })

  it('does not include login signal when lastLoginDaysAgo <= 14', () => {
    const result = buildTriggerReason({ ...baseSignals, lastLoginDaysAgo: 10 })
    expect(result).toBe('Aucun signal actif')
  })

  it('does not include churn risk when < 70', () => {
    const result = buildTriggerReason({ ...baseSignals, churnRisk: 69 })
    expect(result).toBe('Aucun signal actif')
  })

  it('does not include health score when >= 40', () => {
    const result = buildTriggerReason({ ...baseSignals, healthScore: 40 })
    expect(result).toBe('Aucun signal actif')
  })
})

// ── buildHubspotImportNote ──────────────────────────────────

describe('buildHubspotImportNote', () => {
  it('generates P0 note with health score', () => {
    const note = buildHubspotImportNote(32, 85, 'P0', 'Appel d\'urgence sous 48h')
    expect(note).toContain('risque critique')
    expect(note).toContain('32/100')
    expect(note).toContain("appel d'urgence sous 48h")
  })

  it('generates P1 note', () => {
    const note = buildHubspotImportNote(55, 60, 'P1', 'Revue compte')
    expect(note).toContain('attention rapide')
    expect(note).toContain('55/100')
    expect(note).toContain('revue compte')
  })

  it('generates P2 note', () => {
    const note = buildHubspotImportNote(80, 20, 'P2', 'Suivi standard')
    expect(note).toContain('sous surveillance')
    expect(note).toContain('80/100')
  })

  it('handles null health score with N/A', () => {
    const note = buildHubspotImportNote(null, null, 'P2', 'Suivi')
    expect(note).toContain('N/A/100')
  })
})

// ── sortAccounts ────────────────────────────────────────────

describe('sortAccounts', () => {
  function makeRow(priority: 'P0' | 'P1' | 'P2', mrrEuros: number): ReturnType<typeof sortAccounts>[0] {
    return {
      stripe_customer_id: `cus_${priority}_${mrrEuros}`,
      hubspot_company_id: null,
      plan_tier: 'growth',
      mrr_euros: mrrEuros,
      health_score: 50,
      churn_risk_score: 50,
      expansion_score: 50,
      segment: null,
      days_to_renewal: null,
      billing_interval: 'monthly',
      trigger_reason: 'test',
      suggested_playbook: 'test',
      suggested_action: 'test',
      priority,
      last_login_days_ago: null,
      open_ticket_count: null,
      nps_score: null,
      hubspot_import_note: 'test',
    }
  }

  it('sorts P0 before P1 before P2', () => {
    const rows = [makeRow('P2', 100), makeRow('P0', 100), makeRow('P1', 100)]
    const sorted = sortAccounts(rows)
    expect(sorted[0].priority).toBe('P0')
    expect(sorted[1].priority).toBe('P1')
    expect(sorted[2].priority).toBe('P2')
  })

  it('sorts by MRR descending within same priority', () => {
    const rows = [makeRow('P1', 50), makeRow('P1', 200), makeRow('P1', 100)]
    const sorted = sortAccounts(rows)
    expect(sorted[0].mrr_euros).toBe(200)
    expect(sorted[1].mrr_euros).toBe(100)
    expect(sorted[2].mrr_euros).toBe(50)
  })

  it('combined sort: P0 high MRR > P0 low MRR > P1 high MRR > P2', () => {
    const rows = [
      makeRow('P2', 500),
      makeRow('P0', 50),
      makeRow('P1', 300),
      makeRow('P0', 200),
      makeRow('P1', 100),
    ]
    const sorted = sortAccounts(rows)
    expect(sorted.map((r) => `${r.priority}-${r.mrr_euros}`)).toEqual([
      'P0-200', 'P0-50', 'P1-300', 'P1-100', 'P2-500',
    ])
  })

  it('handles empty array', () => {
    expect(sortAccounts([])).toEqual([])
  })
})

// ── buildCsv ────────────────────────────────────────────────

describe('buildCsv', () => {
  function makeRow(overrides: Partial<ReturnType<typeof sortAccounts>[0]> = {}): ReturnType<typeof sortAccounts>[0] {
    return {
      stripe_customer_id: 'cus_123',
      hubspot_company_id: 'hub_456',
      plan_tier: 'growth',
      mrr_euros: 150.5,
      health_score: 72,
      churn_risk_score: 45,
      expansion_score: 60,
      segment: 'Champions',
      days_to_renewal: 30,
      billing_interval: 'annual',
      trigger_reason: 'Logins en baisse',
      suggested_playbook: 'Anti-churn',
      suggested_action: 'Appel urgence',
      priority: 'P1',
      last_login_days_ago: 7,
      open_ticket_count: 2,
      nps_score: 8,
      hubspot_import_note: 'Ce compte necessite attention.',
      ...overrides,
    }
  }

  it('produces header + data rows', () => {
    const csv = buildCsv([makeRow()])
    const lines = csv.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('stripe_customer_id')
    expect(lines[0]).toContain('hubspot_import_note')
  })

  it('produces correct column count', () => {
    const csv = buildCsv([makeRow()])
    const lines = csv.split('\n')
    // Header has 18 columns
    expect(lines[0].split(',').length).toBe(18)
  })

  it('JSON and CSV produce same account count', () => {
    const rows = [makeRow(), makeRow({ stripe_customer_id: 'cus_789' }), makeRow({ stripe_customer_id: 'cus_abc' })]
    const csv = buildCsv(rows)
    const csvDataLines = csv.split('\n').slice(1)
    expect(csvDataLines.length).toBe(rows.length)
  })

  it('handles null values as empty strings', () => {
    const csv = buildCsv([makeRow({ hubspot_company_id: null, nps_score: null })])
    const lines = csv.split('\n')
    const values = lines[1].split(',')
    // hubspot_company_id is index 1
    expect(values[1]).toBe('')
  })

  it('escapes commas in values', () => {
    const csv = buildCsv([makeRow({ trigger_reason: 'Signal A, Signal B' })])
    expect(csv).toContain('"Signal A, Signal B"')
  })

  it('escapes quotes in values', () => {
    const csv = buildCsv([makeRow({ trigger_reason: 'Risque "critique"' })])
    expect(csv).toContain('"Risque ""critique"""')
  })

  it('returns header only for empty array', () => {
    const csv = buildCsv([])
    const lines = csv.split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('stripe_customer_id')
  })
})
