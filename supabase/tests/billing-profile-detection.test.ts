import { describe, it, expect } from 'vitest'

// ── Mirror of the needs_review decision (sync-stripe/index.ts) — jsr:
// dependent file, same convention as calculate-scores-churn.test.ts.
// docs/openspec.md §11 — Phase 3. ───────────────────────────────────────

interface BillingProfileFlags {
  metered_subscriptions: number
  multi_item_subscriptions: number
  null_unit_amount_prices: number
  invoice_only_accounts: number
  multi_currency: boolean
  has_subscription_schedules: boolean
}

function determineBillingProfile(flags: BillingProfileFlags): 'standard' | 'needs_review' {
  const needsReview = flags.invoice_only_accounts > 0
    || flags.metered_subscriptions > 0
    || flags.null_unit_amount_prices > 0
    || flags.multi_currency
    || flags.has_subscription_schedules
  return needsReview ? 'needs_review' : 'standard'
}

const CLEAN_FLAGS: BillingProfileFlags = {
  metered_subscriptions: 0,
  multi_item_subscriptions: 0,
  null_unit_amount_prices: 0,
  invoice_only_accounts: 0,
  multi_currency: false,
  has_subscription_schedules: false,
}

describe('determineBillingProfile', () => {
  it('all flags clean → standard', () => {
    expect(determineBillingProfile(CLEAN_FLAGS)).toBe('standard')
  })

  it('multi_item_subscriptions alone does NOT trigger needs_review (Phase 2.2 already handles it correctly)', () => {
    expect(determineBillingProfile({ ...CLEAN_FLAGS, multi_item_subscriptions: 5 })).toBe('standard')
  })

  it('invoice_only_accounts > 0 → needs_review', () => {
    expect(determineBillingProfile({ ...CLEAN_FLAGS, invoice_only_accounts: 1 })).toBe('needs_review')
  })

  it('metered_subscriptions > 0 → needs_review', () => {
    expect(determineBillingProfile({ ...CLEAN_FLAGS, metered_subscriptions: 2 })).toBe('needs_review')
  })

  it('null_unit_amount_prices > 0 → needs_review', () => {
    expect(determineBillingProfile({ ...CLEAN_FLAGS, null_unit_amount_prices: 1 })).toBe('needs_review')
  })

  it('multi_currency → needs_review', () => {
    expect(determineBillingProfile({ ...CLEAN_FLAGS, multi_currency: true })).toBe('needs_review')
  })

  it('has_subscription_schedules → needs_review', () => {
    expect(determineBillingProfile({ ...CLEAN_FLAGS, has_subscription_schedules: true })).toBe('needs_review')
  })
})
