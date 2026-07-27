import { describe, it, expect } from 'vitest'
import { resolveMergeTags, formatAmountAtRisk, escapeCsvField, generateExportCsv } from '../functions/_shared/merge-tags'

// ── Résolution merge-tags (T004) ────────────────────────────

describe('resolveMergeTags', () => {
  it('resolves {company} from display_name', () => {
    const result = resolveMergeTags('Hi {company} team', {
      display_name: 'Acme Corp',
      mrr_cents: 10000,
      days_since_last_activity: 5,
    })
    expect(result).toBe('Hi Acme Corp team')
  })

  it('falls back to a generic label when display_name is missing', () => {
    const result = resolveMergeTags('Hi {company} team', {
      display_name: null,
      mrr_cents: 10000,
      days_since_last_activity: 5,
    })
    expect(result).not.toContain('{company}')
    expect(result).toContain('this account')
  })

  it('resolves {amount_at_risk} formatted as currency', () => {
    const result = resolveMergeTags('Amount at risk: {amount_at_risk}', {
      display_name: 'Acme',
      mrr_cents: 149900,
      days_since_last_activity: 0,
    })
    expect(result).toBe('Amount at risk: $1499.00')
  })

  it('resolves {days_since_last_activity}', () => {
    const result = resolveMergeTags('Inactive for {days_since_last_activity} days', {
      display_name: 'Acme',
      mrr_cents: 0,
      days_since_last_activity: 42,
    })
    expect(result).toBe('Inactive for 42 days')
  })

  it('falls back explicitly when days_since_last_activity is null', () => {
    const result = resolveMergeTags('Inactive for {days_since_last_activity} days', {
      display_name: 'Acme',
      mrr_cents: 0,
      days_since_last_activity: null,
    })
    expect(result).not.toContain('{days_since_last_activity}')
    expect(result).toBe('Inactive for unknown days')
  })

  it('never leaves a raw merge-tag unresolved', () => {
    const result = resolveMergeTags('{company} — {amount_at_risk} — {days_since_last_activity}', {
      display_name: null,
      mrr_cents: null,
      days_since_last_activity: null,
    })
    expect(result).not.toMatch(/\{[a-z_]+\}/)
  })
})

describe('formatAmountAtRisk', () => {
  it('formats cents as USD with two decimals', () => {
    expect(formatAmountAtRisk(149900)).toBe('$1499.00')
  })

  it('defaults to $0.00 when null', () => {
    expect(formatAmountAtRisk(null)).toBe('$0.00')
  })
})

// ── Génération CSV RFC 4180 (T005) ──────────────────────────

describe('generateExportCsv — RFC 4180 escaping', () => {
  it('emits the fixed header row', () => {
    const csv = generateExportCsv([])
    expect(csv).toBe('account_ref,mrr_at_risk_cents,message\n')
  })

  it('emits one row per account', () => {
    const csv = generateExportCsv([
      { account_ref: 'cus_123', mrr_at_risk_cents: 5000, message: 'Hello' },
    ])
    expect(csv).toBe('account_ref,mrr_at_risk_cents,message\ncus_123,5000,Hello\n')
  })

  it('escapes fields containing a comma', () => {
    const csv = generateExportCsv([
      { account_ref: 'cus_123', mrr_at_risk_cents: 0, message: 'Hi, there' },
    ])
    expect(csv).toContain('"Hi, there"')
  })

  it('escapes and doubles internal quotes', () => {
    const csv = generateExportCsv([
      { account_ref: 'cus_123', mrr_at_risk_cents: 0, message: 'Say "hello"' },
    ])
    expect(csv).toContain('"Say ""hello"""')
  })

  it('escapes fields containing a line break', () => {
    const csv = generateExportCsv([
      { account_ref: 'cus_123', mrr_at_risk_cents: 0, message: 'Line1\nLine2' },
    ])
    expect(csv).toContain('"Line1\nLine2"')
  })

  it('does not escape fields without special characters', () => {
    expect(escapeCsvField('plain text')).toBe('plain text')
  })
})

// ── Zero-PII (T006) ──────────────────────────────────────────

describe('Zero-PII guarantee', () => {
  it('resolveMergeTags never introduces an email, phone or IP pattern', () => {
    const result = resolveMergeTags('{company} — {amount_at_risk} — {days_since_last_activity}', {
      display_name: 'Acme Corp',
      mrr_cents: 149900,
      days_since_last_activity: 12,
    })
    expect(result).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
    expect(result).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
    expect(result).not.toMatch(/\+?\d[\d\s().-]{7,}\d/)
  })

  it('generateExportCsv output contains no email/phone/IP across a full row', () => {
    const csv = generateExportCsv([
      { account_ref: 'cus_abc123', mrr_at_risk_cents: 149900, message: 'Hi Acme Corp, following up.' },
    ])
    expect(csv).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
    expect(csv).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
  })
})
