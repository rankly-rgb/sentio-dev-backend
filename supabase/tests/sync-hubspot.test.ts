import { describe, it, expect } from 'vitest'
import {
  normalizeLifecycleStage,
  parseHubSpotDate,
  parsePositiveInt,
  mapHubSpotProperties,
  buildStripeIdMap,
  buildHubspotIdMap,
  matchCompanyToAccount,
  computeReversePushList,
  batchArray,
} from '../functions/_shared/hubspot-sync-helpers.ts'

// ── normalizeLifecycleStage ──────────────────────────────────

describe('normalizeLifecycleStage', () => {
  it('maps customer → customer', () => {
    expect(normalizeLifecycleStage('customer')).toBe('customer')
  })

  it('maps evangelist → evangelist', () => {
    expect(normalizeLifecycleStage('evangelist')).toBe('evangelist')
  })

  it('maps subscriber → subscriber', () => {
    expect(normalizeLifecycleStage('subscriber')).toBe('subscriber')
  })

  it('maps lead → other (not in allowed list)', () => {
    expect(normalizeLifecycleStage('lead')).toBe('other')
  })

  it('maps marketingqualifiedlead → other', () => {
    expect(normalizeLifecycleStage('marketingqualifiedlead')).toBe('other')
  })

  it('maps opportunity → other', () => {
    expect(normalizeLifecycleStage('opportunity')).toBe('other')
  })

  it('returns null for null input', () => {
    expect(normalizeLifecycleStage(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(normalizeLifecycleStage(undefined)).toBeNull()
  })

  it('is case-insensitive', () => {
    expect(normalizeLifecycleStage('CUSTOMER')).toBe('customer')
    expect(normalizeLifecycleStage('Customer')).toBe('customer')
  })
})

// ── parseHubSpotDate ─────────────────────────────────────────

describe('parseHubSpotDate', () => {
  it('parses ISO date string to DATE format', () => {
    expect(parseHubSpotDate('2024-03-15T10:30:00Z')).toBe('2024-03-15')
  })

  it('parses date-only string', () => {
    expect(parseHubSpotDate('2024-03-15')).toBe('2024-03-15')
  })

  it('parses HubSpot timestamp (ms since epoch)', () => {
    const result = parseHubSpotDate('2024-01-01T00:00:00.000Z')
    expect(result).toBe('2024-01-01')
  })

  it('returns null for null', () => {
    expect(parseHubSpotDate(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(parseHubSpotDate(undefined)).toBeNull()
  })

  it('returns null for invalid date string', () => {
    expect(parseHubSpotDate('not-a-date')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseHubSpotDate('')).toBeNull()
  })
})

// ── parsePositiveInt ─────────────────────────────────────────

describe('parsePositiveInt', () => {
  it('parses string integer', () => {
    expect(parsePositiveInt('5')).toBe(5)
  })

  it('returns 0 for null', () => {
    expect(parsePositiveInt(null)).toBe(0)
  })

  it('returns 0 for undefined', () => {
    expect(parsePositiveInt(undefined)).toBe(0)
  })

  it('returns 0 for negative value', () => {
    expect(parsePositiveInt('-3')).toBe(0)
  })

  it('returns 0 for non-numeric string', () => {
    expect(parsePositiveInt('abc')).toBe(0)
  })

  it('returns 0 for empty string', () => {
    expect(parsePositiveInt('')).toBe(0)
  })
})

// ── mapHubSpotProperties ─────────────────────────────────────

describe('mapHubSpotProperties', () => {
  it('maps all fields correctly from HubSpot response', () => {
    const result = mapHubSpotProperties({
      lifecyclestage: 'customer',
      num_open_deals: '3',
      hs_ticket_count: '2',
      hs_last_meeting_booked: '2024-03-10T09:00:00Z',
      notes_last_contacted: '2024-03-08T14:00:00Z',
    })

    expect(result.lifecycle_stage).toBe('customer')
    expect(result.open_deal_count).toBe(3)
    expect(result.open_ticket_count).toBe(2)
    expect(result.last_meeting_date).toBe('2024-03-10')
    expect(result.last_email_date).toBe('2024-03-08')
  })

  it('returns safe defaults when all properties are null', () => {
    const result = mapHubSpotProperties({
      lifecyclestage: null,
      num_open_deals: null,
      hs_ticket_count: null,
      hs_last_meeting_booked: null,
      notes_last_contacted: null,
    })

    expect(result.lifecycle_stage).toBeNull()
    expect(result.open_deal_count).toBe(0)
    expect(result.open_ticket_count).toBe(0)
    expect(result.last_meeting_date).toBeNull()
    expect(result.last_email_date).toBeNull()
  })

  it('normalizes unknown lifecycle stage to other', () => {
    const result = mapHubSpotProperties({ lifecyclestage: 'salesqualifiedlead' })
    expect(result.lifecycle_stage).toBe('other')
  })

  it('does not include email, phone or PII fields (Zero-PII)', () => {
    const result = mapHubSpotProperties({
      lifecyclestage: 'customer',
      num_open_deals: '1',
      hs_ticket_count: '0',
    })
    const keys = Object.keys(result)
    expect(keys).not.toContain('email')
    expect(keys).not.toContain('phone')
    expect(keys).not.toContain('name')
    expect(keys).not.toContain('ip')
  })

  it('handles missing properties gracefully', () => {
    const result = mapHubSpotProperties({})
    expect(result.open_deal_count).toBe(0)
    expect(result.open_ticket_count).toBe(0)
    expect(result.lifecycle_stage).toBeNull()
  })
})

// ── buildStripeIdMap ─────────────────────────────────────────

describe('buildStripeIdMap', () => {
  it('maps stripe_customer_id to account_id', () => {
    const accounts = [
      { id: 'acc-1', stripe_customer_id: 'cus_abc', hubspot_company_id: null },
      { id: 'acc-2', stripe_customer_id: 'cus_def', hubspot_company_id: 'hs-1' },
    ]
    const map = buildStripeIdMap(accounts)
    expect(map.get('cus_abc')).toBe('acc-1')
    expect(map.get('cus_def')).toBe('acc-2')
    expect(map.size).toBe(2)
  })

  it('ignores accounts without stripe_customer_id', () => {
    const accounts = [
      { id: 'acc-1', stripe_customer_id: null, hubspot_company_id: null },
      { id: 'acc-2', stripe_customer_id: 'cus_abc', hubspot_company_id: null },
    ]
    expect(buildStripeIdMap(accounts).size).toBe(1)
  })
})

// ── buildHubspotIdMap ────────────────────────────────────────

describe('buildHubspotIdMap', () => {
  it('maps hubspot_company_id to account_id', () => {
    const accounts = [
      { id: 'acc-1', hubspot_company_id: 'hs-1', stripe_customer_id: null },
      { id: 'acc-2', hubspot_company_id: null, stripe_customer_id: 'cus_abc' },
    ]
    const map = buildHubspotIdMap(accounts)
    expect(map.get('hs-1')).toBe('acc-1')
    expect(map.size).toBe(1)
  })
})

// ── matchCompanyToAccount ────────────────────────────────────

describe('matchCompanyToAccount', () => {
  const stripeMap = new Map([['cus_abc', 'acc-1'], ['cus_def', 'acc-2']])
  const linkedMap = new Map([['hs-existing', 'acc-3']])

  it('retourne null si aucun match', () => {
    const company = { id: 'hs-new', properties: {} }
    expect(matchCompanyToAccount(company, stripeMap, linkedMap)).toBeNull()
  })

  it('match via lien existant (hubspot_company_id)', () => {
    const company = { id: 'hs-existing', properties: {} }
    expect(matchCompanyToAccount(company, stripeMap, linkedMap)).toBe('acc-3')
  })

  it('match via id_stripe', () => {
    const company = { id: 'hs-new', properties: { id_stripe: 'cus_abc' } }
    expect(matchCompanyToAccount(company, stripeMap, linkedMap)).toBe('acc-1')
  })

  it('trim whitespace dans id_stripe', () => {
    const company = { id: 'hs-new', properties: { id_stripe: '  cus_def  ' } }
    expect(matchCompanyToAccount(company, stripeMap, linkedMap)).toBe('acc-2')
  })

  it('id_stripe vide → null', () => {
    const company = { id: 'hs-new', properties: { id_stripe: '' } }
    expect(matchCompanyToAccount(company, stripeMap, linkedMap)).toBeNull()
  })

  it('prioritise le lien existant sur id_stripe', () => {
    const company = { id: 'hs-existing', properties: { id_stripe: 'cus_abc' } }
    expect(matchCompanyToAccount(company, stripeMap, linkedMap)).toBe('acc-3')
  })
})

// ── computeReversePushList ───────────────────────────────────

describe('computeReversePushList', () => {
  it('retourne les paires hubspot_company_id / stripe_customer_id', () => {
    const linked = [
      { hubspot_company_id: 'hs-1', account_id: 'acc-1' },
      { hubspot_company_id: 'hs-2', account_id: 'acc-2' },
    ]
    const accounts = [
      { id: 'acc-1', stripe_customer_id: 'cus_abc' },
      { id: 'acc-2', stripe_customer_id: null },
    ]
    const result = computeReversePushList(linked, accounts)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ hubspot_company_id: 'hs-1', stripe_customer_id: 'cus_abc' })
  })

  it('retourne [] si aucun stripe_customer_id', () => {
    const linked = [{ hubspot_company_id: 'hs-1', account_id: 'acc-1' }]
    const accounts = [{ id: 'acc-1', stripe_customer_id: null }]
    expect(computeReversePushList(linked, accounts)).toHaveLength(0)
  })
})

// ── batchArray ───────────────────────────────────────────────

describe('batchArray', () => {
  it('découpe en lots de taille donnée', () => {
    const items = [1, 2, 3, 4, 5]
    expect(batchArray(items, 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('retourne [] si tableau vide', () => {
    expect(batchArray([], 10)).toEqual([])
  })

  it('retourne un seul lot si taille >= longueur', () => {
    expect(batchArray([1, 2, 3], 10)).toEqual([[1, 2, 3]])
  })
})
