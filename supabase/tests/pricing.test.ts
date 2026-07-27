import { describe, it, expect } from 'vitest'
import { checkAccountLimitGate, calculateUsagePct, isDowngradeIncoherent, type TierLimits } from '../functions/_shared/pricing'

const growthLimits: TierLimits = {
  plan_tier: 'growth',
  max_active_accounts: 100,
  requires_appointment: false,
  alert_threshold_pct: 90,
}

const enterpriseLimits: TierLimits = {
  plan_tier: 'enterprise',
  max_active_accounts: null,
  requires_appointment: true,
  alert_threshold_pct: 90,
}

// ── T007 ──────────────────────────────────────────────────────

describe('checkAccountLimitGate', () => {
  it('no gating below the limit', () => {
    const result = checkAccountLimitGate(50, growthLimits)
    expect(result.gating_active).toBe(false)
  })

  it('gating active above the limit', () => {
    const result = checkAccountLimitGate(101, growthLimits)
    expect(result.gating_active).toBe(true)
  })

  it('gating active exactly at the limit + 1, not at the limit itself', () => {
    expect(checkAccountLimitGate(100, growthLimits).gating_active).toBe(false)
    expect(checkAccountLimitGate(101, growthLimits).gating_active).toBe(true)
  })

  it('enterprise tier (max_active_accounts = null) is never gated, regardless of volume', () => {
    const result = checkAccountLimitGate(1_000_000, enterpriseLimits)
    expect(result.gating_active).toBe(false)
    expect(result.alert_active).toBe(false)
    expect(result.usage_pct).toBeNull()
  })

  it('alert_active true once usage_pct crosses alert_threshold_pct', () => {
    expect(checkAccountLimitGate(89, growthLimits).alert_active).toBe(false)
    expect(checkAccountLimitGate(90, growthLimits).alert_active).toBe(true)
  })
})

// ── T008 ──────────────────────────────────────────────────────

describe('calculateUsagePct', () => {
  it('computes the correct percentage', () => {
    expect(calculateUsagePct(50, 100)).toBe(50)
    expect(calculateUsagePct(90, 100)).toBe(90)
  })

  it('returns null when max_active_accounts is null (unlimited)', () => {
    expect(calculateUsagePct(500, null)).toBeNull()
  })

  it('returns null when max_active_accounts is 0 or negative (guards division)', () => {
    expect(calculateUsagePct(10, 0)).toBeNull()
  })
})

describe('isDowngradeIncoherent (FR-013)', () => {
  it('true when active_accounts_count exceeds the target tier limit', () => {
    expect(isDowngradeIncoherent(growthLimits, 150)).toBe(true)
  })

  it('false when active_accounts_count is within the target tier limit', () => {
    expect(isDowngradeIncoherent(growthLimits, 50)).toBe(false)
  })

  it('never incoherent for a null (unlimited) target tier', () => {
    expect(isDowngradeIncoherent(enterpriseLimits, 1_000_000)).toBe(false)
  })
})
