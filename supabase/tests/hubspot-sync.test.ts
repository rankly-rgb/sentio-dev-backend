import { describe, it, expect } from 'vitest'
import {
  buildStripeIdMap,
  buildHubspotIdMap,
  matchCompanyToAccount,
  computeReversePushList,
  batchArray,
} from '../functions/_shared/hubspot-sync-helpers'

// ── buildStripeIdMap ─────────────────────────────────────────

describe('buildStripeIdMap', () => {
  it('maps stripe_customer_id to account id', () => {
    const accounts = [
      { id: 'acc-1', stripe_customer_id: 'cus_abc', hubspot_company_id: null },
      { id: 'acc-2', stripe_customer_id: 'cus_def', hubspot_company_id: 'hs-1' },
    ]
    const map = buildStripeIdMap(accounts)
    expect(map.get('cus_abc')).toBe('acc-1')
    expect(map.get('cus_def')).toBe('acc-2')
    expect(map.size).toBe(2)
  })

  it('skips accounts without stripe_customer_id', () => {
    const accounts = [
      { id: 'acc-1', stripe_customer_id: null },
      { id: 'acc-2', stripe_customer_id: 'cus_xyz' },
    ]
    const map = buildStripeIdMap(accounts)
    expect(map.size).toBe(1)
    expect(map.get('cus_xyz')).toBe('acc-2')
  })

  it('handles empty array', () => {
    expect(buildStripeIdMap([]).size).toBe(0)
  })
})

// ── buildHubspotIdMap ────────────────────────────────────────

describe('buildHubspotIdMap', () => {
  it('maps hubspot_company_id to account id', () => {
    const accounts = [
      { id: 'acc-1', hubspot_company_id: 'hs-100' },
      { id: 'acc-2', hubspot_company_id: null },
    ]
    const map = buildHubspotIdMap(accounts)
    expect(map.get('hs-100')).toBe('acc-1')
    expect(map.size).toBe(1)
  })
})

// ── matchCompanyToAccount ────────────────────────────────────

describe('matchCompanyToAccount', () => {
  const stripeMap = new Map([['cus_abc', 'acc-1'], ['cus_def', 'acc-2']])
  const linkedMap = new Map([['hs-existing', 'acc-3']])

  it('returns existing account if already linked by hubspot_company_id', () => {
    const company = { id: 'hs-existing', properties: { id_stripe: 'cus_abc' } }
    expect(matchCompanyToAccount(company, stripeMap, linkedMap)).toBe('acc-3')
  })

  it('matches via id_stripe when not already linked', () => {
    const company = { id: 'hs-new', properties: { id_stripe: 'cus_abc' } }
    expect(matchCompanyToAccount(company, stripeMap, linkedMap)).toBe('acc-1')
  })

  it('matches via id_stripe with whitespace', () => {
    const company = { id: 'hs-new', properties: { id_stripe: '  cus_def  ' } }
    expect(matchCompanyToAccount(company, stripeMap, linkedMap)).toBe('acc-2')
  })

  it('returns null when id_stripe is empty', () => {
    const company = { id: 'hs-new', properties: { id_stripe: '' } }
    expect(matchCompanyToAccount(company, stripeMap, linkedMap)).toBeNull()
  })

  it('returns null when id_stripe is null', () => {
    const company = { id: 'hs-new', properties: { id_stripe: null } }
    expect(matchCompanyToAccount(company, stripeMap, linkedMap)).toBeNull()
  })

  it('returns null when id_stripe is undefined', () => {
    const company = { id: 'hs-new', properties: {} }
    expect(matchCompanyToAccount(company, stripeMap, linkedMap)).toBeNull()
  })

  it('returns null when no matching stripe_customer_id found', () => {
    const company = { id: 'hs-new', properties: { id_stripe: 'cus_unknown' } }
    expect(matchCompanyToAccount(company, stripeMap, linkedMap)).toBeNull()
  })

  it('prioritizes existing link over id_stripe match', () => {
    // Company already linked to acc-3, but id_stripe points to acc-1
    const company = { id: 'hs-existing', properties: { id_stripe: 'cus_abc' } }
    expect(matchCompanyToAccount(company, stripeMap, linkedMap)).toBe('acc-3')
  })
})

// ── computeReversePushList ───────────────────────────────────

describe('computeReversePushList', () => {
  it('builds push list for linked accounts with stripe_customer_id', () => {
    const linked = [
      { hubspot_company_id: 'hs-1', account_id: 'acc-1' },
      { hubspot_company_id: 'hs-2', account_id: 'acc-2' },
    ]
    const accounts = [
      { id: 'acc-1', stripe_customer_id: 'cus_abc' },
      { id: 'acc-2', stripe_customer_id: 'cus_def' },
    ]
    const result = computeReversePushList(linked, accounts)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ hubspot_company_id: 'hs-1', stripe_customer_id: 'cus_abc' })
    expect(result[1]).toEqual({ hubspot_company_id: 'hs-2', stripe_customer_id: 'cus_def' })
  })

  it('skips accounts without stripe_customer_id', () => {
    const linked = [
      { hubspot_company_id: 'hs-1', account_id: 'acc-1' },
    ]
    const accounts = [
      { id: 'acc-1', stripe_customer_id: null },
    ]
    expect(computeReversePushList(linked, accounts)).toHaveLength(0)
  })

  it('skips linked accounts not found in accounts list', () => {
    const linked = [
      { hubspot_company_id: 'hs-1', account_id: 'acc-missing' },
    ]
    const accounts = [
      { id: 'acc-1', stripe_customer_id: 'cus_abc' },
    ]
    expect(computeReversePushList(linked, accounts)).toHaveLength(0)
  })

  it('handles empty arrays', () => {
    expect(computeReversePushList([], [])).toHaveLength(0)
  })
})

// ── batchArray ───────────────────────────────────────────────

describe('batchArray', () => {
  it('splits into correct batch sizes', () => {
    const items = [1, 2, 3, 4, 5]
    const batches = batchArray(items, 2)
    expect(batches).toEqual([[1, 2], [3, 4], [5]])
  })

  it('handles exact batch size', () => {
    const batches = batchArray([1, 2, 3, 4], 2)
    expect(batches).toEqual([[1, 2], [3, 4]])
  })

  it('handles single batch', () => {
    const batches = batchArray([1, 2], 100)
    expect(batches).toEqual([[1, 2]])
  })

  it('handles empty array', () => {
    expect(batchArray([], 10)).toEqual([])
  })
})
