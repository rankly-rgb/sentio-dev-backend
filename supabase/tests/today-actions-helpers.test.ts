import { describe, it, expect } from 'vitest'
import {
  computeDaysToRenewal,
  computePriority,
  computeTriggerReasons,
  computeTodayActions,
  buildTodayActionsSummary,
  determinePortfolioStatus,
  type TodayAccountInput,
  type TodayPlaybookInput,
  type TodayInsightInput,
} from '../functions/_shared/today-actions-helpers'

function account(overrides: Partial<TodayAccountInput> = {}): TodayAccountInput {
  return {
    id: 'a1',
    stripe_customer_id: 'cus_a1',
    hubspot_company_id: null,
    display_name: 'Acme',
    health_score: 80,
    churn_risk_score: 10,
    expansion_score: 0,
    mrr_cents: 10000,
    plan_tier: 'growth',
    contract_end_date: null,
    billing_interval: null,
    ...overrides,
  }
}

function playbook(overrides: Partial<TodayPlaybookInput> = {}): TodayPlaybookInput {
  return {
    id: 'pb1',
    title: 'Payment Recovery',
    priority: 'high',
    template_category: 'payment_recovery',
    status: 'active',
    eligibility_criteria: null,
    ...overrides,
  }
}

describe('computeDaysToRenewal', () => {
  it('returns null when no contract_end_date', () => {
    expect(computeDaysToRenewal(null, 'annual')).toBeNull()
  })

  it('returns null for monthly billing regardless of contract_end_date', () => {
    const future = new Date(Date.now() + 30 * 86400000).toISOString()
    expect(computeDaysToRenewal(future, 'monthly')).toBeNull()
  })

  it('returns a positive day count for a future annual renewal', () => {
    const future = new Date(Date.now() + 10 * 86400000).toISOString()
    const days = computeDaysToRenewal(future, 'annual')
    expect(days).toBeGreaterThanOrEqual(9)
    expect(days).toBeLessThanOrEqual(11)
  })
})

describe('computePriority', () => {
  it('is P0 for churn_risk_score >= 70 with no insights', () => {
    expect(computePriority(75, null, [])).toBe('P0')
  })

  it('is P1 for churn_risk_score >= 50', () => {
    expect(computePriority(55, null, [])).toBe('P1')
  })

  it('is P1 when renewal is within 60 days regardless of churn score', () => {
    expect(computePriority(10, 45, [])).toBe('P1')
  })

  it('is P2 by default', () => {
    expect(computePriority(10, null, [])).toBe('P2')
  })

  it('a critical insight elevates a low-risk account to P0', () => {
    expect(computePriority(10, null, ['critical'])).toBe('P0')
  })

  it('a high insight elevates a P2 account to P1 but not P0', () => {
    expect(computePriority(10, null, ['high'])).toBe('P1')
  })

  it('never downgrades priority — a P0 account stays P0 even with a low insight', () => {
    expect(computePriority(80, null, ['low'])).toBe('P0')
  })

  it('takes the worst (most urgent) priority across multiple insights', () => {
    expect(computePriority(10, null, ['low', 'critical', 'medium'])).toBe('P0')
  })
})

describe('computeTriggerReasons', () => {
  it('includes insight titles first', () => {
    const reasons = computeTriggerReasons(account({ churn_risk_score: 10, health_score: 90 }), ['Late payment detected'])
    expect(reasons[0]).toBe('Late payment detected')
  })

  it('adds a critical churn risk reason above 70', () => {
    const reasons = computeTriggerReasons(account({ churn_risk_score: 85 }), [])
    expect(reasons.some((r) => r.includes('Critical churn risk'))).toBe(true)
  })

  it('adds a low health score reason under 40', () => {
    const reasons = computeTriggerReasons(account({ health_score: 20, churn_risk_score: 0 }), [])
    expect(reasons.some((r) => r.includes('Low health score'))).toBe(true)
  })
})

describe('computeTodayActions', () => {
  it('includes an account that matches an active playbook, even with zero insights', () => {
    const actions = computeTodayActions([account()], [playbook()], new Map())
    expect(actions).toHaveLength(1)
    expect(actions[0].matching_playbooks).toHaveLength(1)
  })

  it('includes an account with an active insight even when no playbook matches it', () => {
    const criteria = { operator: 'AND' as const, conditions: [{ field: 'mrr_cents', operator: 'gt' as const, value: 999999 }] }
    const insights = new Map<string, TodayInsightInput[]>([['a1', [{ title: 'Critical churn risk detected', priority: 'critical' }]]])
    const actions = computeTodayActions([account()], [playbook({ eligibility_criteria: criteria })], insights)
    expect(actions).toHaveLength(1)
    expect(actions[0].matching_playbooks).toHaveLength(0)
    expect(actions[0].priority).toBe('P0')
  })

  it('ignores playbooks that are not active', () => {
    const actions = computeTodayActions([account()], [playbook({ status: 'draft' })], new Map())
    expect(actions).toHaveLength(0)
  })

  it('merges playbook match and insight on the same account into one action', () => {
    const insights = new Map<string, TodayInsightInput[]>([['a1', [{ title: 'Usage dropped', priority: 'medium' }]]])
    const actions = computeTodayActions([account()], [playbook()], insights)
    expect(actions).toHaveLength(1)
    expect(actions[0].matching_playbooks).toHaveLength(1)
    expect(actions[0].trigger_reasons).toContain('Usage dropped')
  })

  it('returns nothing for an account with no playbook match and no insights', () => {
    const criteria = { operator: 'AND' as const, conditions: [{ field: 'mrr_cents', operator: 'gt' as const, value: 999999 }] }
    const actions = computeTodayActions([account()], [playbook({ eligibility_criteria: criteria })], new Map())
    expect(actions).toHaveLength(0)
  })
})

describe('buildTodayActionsSummary', () => {
  it('counts by priority and sums MRR at risk for P0/P1 only', () => {
    const actions = computeTodayActions(
      [account({ id: 'a1', churn_risk_score: 80, mrr_cents: 5000 }), account({ id: 'a2', churn_risk_score: 10, mrr_cents: 3000 })],
      [playbook({ eligibility_criteria: null })],
      new Map(),
    )
    const summary = buildTodayActionsSummary(actions)
    expect(summary.total).toBe(2)
    expect(summary.by_priority.P0).toBe(1)
    expect(summary.by_priority.P2).toBe(1)
    expect(summary.mrr_at_risk_cents).toBe(5000)
  })
})

describe('determinePortfolioStatus (C2.4a rule)', () => {
  it('is critical whenever at least one critical insight is active, regardless of total', () => {
    expect(determinePortfolioStatus(1, 0)).toBe('critical')
  })

  it('is attention_needed when there are actions but no critical insight', () => {
    expect(determinePortfolioStatus(0, 5)).toBe('attention_needed')
  })

  it('is stable only when there is no critical insight and no action at all', () => {
    expect(determinePortfolioStatus(0, 0)).toBe('stable')
  })

  it('can never be stable while a critical insight is active — the exact contradiction this chantier closes', () => {
    // Regression guard for the audit finding: "portfolio stable" + "0 priority
    // actions" + "206 critical insights" shown simultaneously.
    expect(determinePortfolioStatus(206, 0)).not.toBe('stable')
  })
})
