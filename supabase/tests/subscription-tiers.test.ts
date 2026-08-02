import { describe, it, expect } from 'vitest'

// ── Types/données miroir (_shared/subscription-tiers.ts) ──────
// (même convention que export-csv.test.ts / export-playbook-csv.test.ts
// — les imports Deno-natifs des Edge Functions ne sont pas exécutables
// sous Vitest/Node)

type SubscriptionTierKey = 'free' | 'growth' | 'scale' | 'enterprise'

interface SubscriptionTier {
  key: SubscriptionTierKey
  display_name: string
  price_cents_monthly: number | null
  max_accounts: number | null
  cta: 'self_serve' | 'contact_sales'
  stripe_price_id_env: string | null
}

const SUBSCRIPTION_TIERS: SubscriptionTier[] = [
  { key: 'free', display_name: 'Free', price_cents_monthly: 0, max_accounts: 30, cta: 'self_serve', stripe_price_id_env: null },
  { key: 'growth', display_name: 'Growth', price_cents_monthly: 12900, max_accounts: 200, cta: 'self_serve', stripe_price_id_env: 'STRIPE_PRICE_ID_GROWTH' },
  { key: 'scale', display_name: 'Scale', price_cents_monthly: 34900, max_accounts: 750, cta: 'self_serve', stripe_price_id_env: 'STRIPE_PRICE_ID_SCALE' },
  { key: 'enterprise', display_name: 'Enterprise', price_cents_monthly: null, max_accounts: null, cta: 'contact_sales', stripe_price_id_env: null },
]

const TIERS_BY_KEY = new Map(SUBSCRIPTION_TIERS.map((t) => [t.key, t]))

function isSubscriptionTierKey(value: string | null | undefined): value is SubscriptionTierKey {
  return value !== null && value !== undefined && TIERS_BY_KEY.has(value as SubscriptionTierKey)
}

function getTier(planType: string | null | undefined): SubscriptionTier {
  if (isSubscriptionTierKey(planType)) return TIERS_BY_KEY.get(planType)!
  return TIERS_BY_KEY.get('free')!
}

function isOverAccountLimit(accountsCount: number, tier: SubscriptionTier): boolean {
  if (tier.max_accounts === null) return false
  return accountsCount > tier.max_accounts
}

const envMock: Record<string, string> = {
  STRIPE_PRICE_ID_GROWTH: 'price_growth_test',
  STRIPE_PRICE_ID_SCALE: 'price_scale_test',
}

function resolveStripePriceId(tier: SubscriptionTier): string | null {
  if (!tier.stripe_price_id_env) return null
  return envMock[tier.stripe_price_id_env] ?? null
}

function findTierByStripePriceId(priceId: string): SubscriptionTier | null {
  for (const tier of SUBSCRIPTION_TIERS) {
    if (resolveStripePriceId(tier) === priceId) return tier
  }
  return null
}

describe('SUBSCRIPTION_TIERS catalogue', () => {
  it('has exactly the 4 V1 tiers with correct pricing', () => {
    expect(SUBSCRIPTION_TIERS.map((t) => t.key)).toEqual(['free', 'growth', 'scale', 'enterprise'])
    expect(SUBSCRIPTION_TIERS.find((t) => t.key === 'free')?.price_cents_monthly).toBe(0)
    expect(SUBSCRIPTION_TIERS.find((t) => t.key === 'growth')?.price_cents_monthly).toBe(12900)
    expect(SUBSCRIPTION_TIERS.find((t) => t.key === 'scale')?.price_cents_monthly).toBe(34900)
    expect(SUBSCRIPTION_TIERS.find((t) => t.key === 'enterprise')?.price_cents_monthly).toBeNull()
  })

  it('has the correct account limits', () => {
    expect(SUBSCRIPTION_TIERS.find((t) => t.key === 'free')?.max_accounts).toBe(30)
    expect(SUBSCRIPTION_TIERS.find((t) => t.key === 'growth')?.max_accounts).toBe(200)
    expect(SUBSCRIPTION_TIERS.find((t) => t.key === 'scale')?.max_accounts).toBe(750)
    expect(SUBSCRIPTION_TIERS.find((t) => t.key === 'enterprise')?.max_accounts).toBeNull()
  })

  it('only Enterprise is contact_sales, the rest are self_serve', () => {
    for (const tier of SUBSCRIPTION_TIERS) {
      if (tier.key === 'enterprise') {
        expect(tier.cta).toBe('contact_sales')
      } else {
        expect(tier.cta).toBe('self_serve')
      }
    }
  })
})

describe('isSubscriptionTierKey', () => {
  it('accepts all 4 valid keys', () => {
    expect(isSubscriptionTierKey('free')).toBe(true)
    expect(isSubscriptionTierKey('growth')).toBe(true)
    expect(isSubscriptionTierKey('scale')).toBe(true)
    expect(isSubscriptionTierKey('enterprise')).toBe(true)
  })

  it('rejects unknown, null, and undefined values', () => {
    expect(isSubscriptionTierKey('starter')).toBe(false)
    expect(isSubscriptionTierKey(null)).toBe(false)
    expect(isSubscriptionTierKey(undefined)).toBe(false)
    expect(isSubscriptionTierKey('')).toBe(false)
  })
})

describe('getTier', () => {
  it('resolves a known tier key', () => {
    expect(getTier('scale').key).toBe('scale')
  })

  it('falls back to free for null', () => {
    expect(getTier(null).key).toBe('free')
  })

  it('falls back to free for undefined', () => {
    expect(getTier(undefined).key).toBe('free')
  })

  it('falls back to free for an unknown/legacy value (e.g. old "starter")', () => {
    expect(getTier('starter').key).toBe('free')
  })
})

describe('isOverAccountLimit', () => {
  it('returns false when under the limit', () => {
    expect(isOverAccountLimit(25, getTier('free'))).toBe(false)
  })

  it('returns false when exactly at the limit', () => {
    expect(isOverAccountLimit(30, getTier('free'))).toBe(false)
  })

  it('returns true when over the limit', () => {
    expect(isOverAccountLimit(31, getTier('free'))).toBe(true)
  })

  it('never returns true for Enterprise (no cap)', () => {
    expect(isOverAccountLimit(1_000_000, getTier('enterprise'))).toBe(false)
  })
})

describe('resolveStripePriceId / findTierByStripePriceId', () => {
  it('resolves the configured price ID for a self-serve tier', () => {
    expect(resolveStripePriceId(getTier('growth'))).toBe('price_growth_test')
  })

  it('returns null for tiers with no Stripe Checkout flow', () => {
    expect(resolveStripePriceId(getTier('free'))).toBeNull()
    expect(resolveStripePriceId(getTier('enterprise'))).toBeNull()
  })

  it('finds the tier matching a given Stripe price ID', () => {
    expect(findTierByStripePriceId('price_scale_test')?.key).toBe('scale')
  })

  it('returns null for an unrecognized price ID', () => {
    expect(findTierByStripePriceId('price_unknown')).toBeNull()
  })
})
