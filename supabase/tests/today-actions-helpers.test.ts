import { describe, it, expect } from 'vitest'
import {
  computeTriggerReasons,
  computeTodayActions,
  sortTodayActions,
  buildTodayActionsSummary,
  getTopActionsByPriority,
  priorityLabel,
  categoryLabel,
  type TodayAccount,
  type PlaybookRef,
  type TodayAction,
} from '../functions/_shared/today-actions-helpers'

// ── Factories ─────────────────────────────────────────────────

function makeAccount(overrides: Partial<TodayAccount> = {}): TodayAccount {
  return {
    id: 'acc-1',
    stripe_customer_id: 'cus_test1',
    hubspot_company_id: null,
    health_score: 50,
    churn_risk_score: 30,
    expansion_score: 40,
    mrr_cents: 10000,
    plan_tier: 'growth',
    billing_interval: 'monthly',
    contract_end_date: null,
    created_at: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

function makePlaybook(overrides: Partial<PlaybookRef> = {}): PlaybookRef {
  return {
    id: 'pb-1',
    title: 'Playbook test',
    priority: 'high',
    template_category: 'churn_prevention',
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'churn_risk_score', operator: 'gte', value: 70 },
      ],
    },
    ...overrides,
  }
}

// ── computeTriggerReasons ─────────────────────────────────────

describe('computeTriggerReasons', () => {
  it('returns churn critique when score >= 70', () => {
    const reasons = computeTriggerReasons(makeAccount({ churn_risk_score: 85 }))
    expect(reasons.some((r) => r.includes('critique'))).toBe(true)
  })

  it('returns churn modéré when score 50-69', () => {
    const reasons = computeTriggerReasons(makeAccount({ churn_risk_score: 55 }))
    expect(reasons.some((r) => r.includes('modéré'))).toBe(true)
  })

  it('returns santé faible when health < 40', () => {
    const reasons = computeTriggerReasons(makeAccount({ health_score: 25 }))
    expect(reasons.some((r) => r.includes('Santé faible'))).toBe(true)
  })

  it('returns renewal warning when days_to_renewal <= 30 (annual)', () => {
    const endDate = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString()
    const reasons = computeTriggerReasons(makeAccount({
      contract_end_date: endDate,
      billing_interval: 'annual',
    }))
    expect(reasons.some((r) => r.includes('Renouvellement'))).toBe(true)
  })

  it('returns expansion opportunity when score >= 70', () => {
    const reasons = computeTriggerReasons(makeAccount({ expansion_score: 80 }))
    expect(reasons.some((r) => r.includes('expansion'))).toBe(true)
  })

  it('returns MRR à zéro when mrr_cents = 0', () => {
    const reasons = computeTriggerReasons(makeAccount({ mrr_cents: 0 }))
    expect(reasons).toContain('MRR à zéro')
  })

  it('returns empty array for healthy account', () => {
    const reasons = computeTriggerReasons(makeAccount({
      churn_risk_score: 10,
      health_score: 80,
      expansion_score: 30,
      mrr_cents: 50000,
    }))
    expect(reasons).toHaveLength(0)
  })

  it('handles null scores gracefully', () => {
    const reasons = computeTriggerReasons(makeAccount({
      churn_risk_score: null,
      health_score: null,
      expansion_score: null,
      mrr_cents: null,
    }))
    // null mrr_cents defaults to 0, so MRR à zéro
    expect(reasons).toContain('MRR à zéro')
    // null churn/health/expansion should not trigger
    expect(reasons.some((r) => r.includes('churn'))).toBe(false)
    expect(reasons.some((r) => r.includes('Santé'))).toBe(false)
  })
})

// ── computeTodayActions ───────────────────────────────────────

describe('computeTodayActions', () => {
  it('returns empty when no accounts match playbooks', () => {
    const accounts = [makeAccount({ churn_risk_score: 10 })]
    const playbooks = [makePlaybook()] // requires churn >= 70
    const result = computeTodayActions(accounts, playbooks)
    expect(result).toHaveLength(0)
  })

  it('matches account to playbook when criteria met', () => {
    const accounts = [makeAccount({ id: 'a1', churn_risk_score: 80 })]
    const playbooks = [makePlaybook()]
    const result = computeTodayActions(accounts, playbooks)
    expect(result).toHaveLength(1)
    expect(result[0].account_id).toBe('a1')
    expect(result[0].matching_playbooks).toHaveLength(1)
    expect(result[0].matching_playbooks[0].title).toBe('Playbook test')
  })

  it('deduplicates accounts matching multiple playbooks', () => {
    const accounts = [makeAccount({ id: 'a1', churn_risk_score: 80 })]
    const playbooks = [
      makePlaybook({ id: 'pb-1', title: 'PB 1' }),
      makePlaybook({ id: 'pb-2', title: 'PB 2' }),
    ]
    const result = computeTodayActions(accounts, playbooks)
    expect(result).toHaveLength(1)
    expect(result[0].matching_playbooks).toHaveLength(2)
  })

  it('does not duplicate same playbook ref', () => {
    const accounts = [makeAccount({ id: 'a1', churn_risk_score: 80 })]
    const playbooks = [makePlaybook({ id: 'pb-1' }), makePlaybook({ id: 'pb-1' })]
    const result = computeTodayActions(accounts, playbooks)
    expect(result[0].matching_playbooks).toHaveLength(1)
  })

  it('returns multiple accounts when multiple match', () => {
    const accounts = [
      makeAccount({ id: 'a1', churn_risk_score: 80 }),
      makeAccount({ id: 'a2', churn_risk_score: 90 }),
      makeAccount({ id: 'a3', churn_risk_score: 10 }), // no match
    ]
    const playbooks = [makePlaybook()]
    const result = computeTodayActions(accounts, playbooks)
    expect(result).toHaveLength(2)
  })

  it('computes priority correctly for matched accounts', () => {
    const endDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString()
    const accounts = [makeAccount({
      id: 'a1',
      churn_risk_score: 80,
      contract_end_date: endDate,
      billing_interval: 'annual',
    })]
    const playbooks = [makePlaybook()]
    const result = computeTodayActions(accounts, playbooks)
    expect(result[0].priority).toBe('P0') // churn >= 70 AND renewal < 30
  })

  it('returns empty when playbooks have no criteria (matches all)', () => {
    const accounts = [makeAccount()]
    const playbooks = [makePlaybook({ eligibility_criteria: null })]
    const result = computeTodayActions(accounts, playbooks)
    // null criteria = match all
    expect(result).toHaveLength(1)
  })

  it('populates trigger_reasons on matched accounts', () => {
    const accounts = [makeAccount({ id: 'a1', churn_risk_score: 85 })]
    const playbooks = [makePlaybook()]
    const result = computeTodayActions(accounts, playbooks)
    expect(result[0].trigger_reasons.length).toBeGreaterThan(0)
    expect(result[0].trigger_reasons.some((r) => r.includes('critique'))).toBe(true)
  })
})

// ── sortTodayActions ──────────────────────────────────────────

describe('sortTodayActions', () => {
  it('sorts P0 before P1 before P2', () => {
    const actions: TodayAction[] = [
      { account_id: 'a', priority: 'P2', mrr_cents: 100 } as TodayAction,
      { account_id: 'b', priority: 'P0', mrr_cents: 100 } as TodayAction,
      { account_id: 'c', priority: 'P1', mrr_cents: 100 } as TodayAction,
    ]
    const sorted = sortTodayActions(actions)
    expect(sorted.map((a) => a.priority)).toEqual(['P0', 'P1', 'P2'])
  })

  it('sorts by MRR desc within same priority', () => {
    const actions: TodayAction[] = [
      { account_id: 'a', priority: 'P0', mrr_cents: 1000 } as TodayAction,
      { account_id: 'b', priority: 'P0', mrr_cents: 5000 } as TodayAction,
      { account_id: 'c', priority: 'P0', mrr_cents: 3000 } as TodayAction,
    ]
    const sorted = sortTodayActions(actions)
    expect(sorted.map((a) => a.mrr_cents)).toEqual([5000, 3000, 1000])
  })

  it('does not mutate original array', () => {
    const actions: TodayAction[] = [
      { account_id: 'a', priority: 'P2', mrr_cents: 100 } as TodayAction,
      { account_id: 'b', priority: 'P0', mrr_cents: 100 } as TodayAction,
    ]
    const sorted = sortTodayActions(actions)
    expect(sorted).not.toBe(actions)
    expect(actions[0].priority).toBe('P2') // unchanged
  })
})

// ── buildTodayActionsSummary ──────────────────────────────────

describe('buildTodayActionsSummary', () => {
  it('counts actions by priority', () => {
    const actions: TodayAction[] = [
      { account_id: 'a', priority: 'P0', mrr_cents: 10000, matching_playbooks: [{ id: 'pb1', title: 't', priority: 'critical', category: 'churn_prevention' }] } as TodayAction,
      { account_id: 'b', priority: 'P0', mrr_cents: 5000, matching_playbooks: [{ id: 'pb1', title: 't', priority: 'critical', category: 'churn_prevention' }] } as TodayAction,
      { account_id: 'c', priority: 'P1', mrr_cents: 3000, matching_playbooks: [{ id: 'pb2', title: 't', priority: 'high', category: 'expansion' }] } as TodayAction,
      { account_id: 'd', priority: 'P2', mrr_cents: 1000, matching_playbooks: [{ id: 'pb3', title: 't', priority: 'medium', category: 'onboarding' }] } as TodayAction,
    ]
    const summary = buildTodayActionsSummary(actions)
    expect(summary.total).toBe(4)
    expect(summary.by_priority).toEqual({ P0: 2, P1: 1, P2: 1 })
  })

  it('computes MRR at risk (P0 + P1 only)', () => {
    const actions: TodayAction[] = [
      { account_id: 'a', priority: 'P0', mrr_cents: 10000, matching_playbooks: [{ id: 'pb1', title: 't', priority: 'critical', category: 'churn_prevention' }] } as TodayAction,
      { account_id: 'b', priority: 'P1', mrr_cents: 5000, matching_playbooks: [{ id: 'pb1', title: 't', priority: 'high', category: 'expansion' }] } as TodayAction,
      { account_id: 'c', priority: 'P2', mrr_cents: 99000, matching_playbooks: [{ id: 'pb2', title: 't', priority: 'medium', category: 'other' }] } as TodayAction,
    ]
    const summary = buildTodayActionsSummary(actions)
    expect(summary.mrr_at_risk_cents).toBe(15000) // P2 excluded
  })

  it('counts by category from matching playbooks', () => {
    const actions: TodayAction[] = [
      { account_id: 'a', priority: 'P0', mrr_cents: 0, matching_playbooks: [
        { id: 'pb1', title: 't', priority: 'critical', category: 'churn_prevention' },
        { id: 'pb2', title: 't', priority: 'high', category: 'expansion' },
      ] } as TodayAction,
    ]
    const summary = buildTodayActionsSummary(actions)
    expect(summary.by_category['churn_prevention']).toBe(1)
    expect(summary.by_category['expansion']).toBe(1)
  })

  it('returns sorted actions', () => {
    const actions: TodayAction[] = [
      { account_id: 'a', priority: 'P2', mrr_cents: 0, matching_playbooks: [] } as unknown as TodayAction,
      { account_id: 'b', priority: 'P0', mrr_cents: 0, matching_playbooks: [] } as unknown as TodayAction,
    ]
    const summary = buildTodayActionsSummary(actions)
    expect(summary.actions[0].priority).toBe('P0')
  })

  it('handles empty actions', () => {
    const summary = buildTodayActionsSummary([])
    expect(summary.total).toBe(0)
    expect(summary.by_priority).toEqual({ P0: 0, P1: 0, P2: 0 })
    expect(summary.mrr_at_risk_cents).toBe(0)
    expect(summary.actions).toHaveLength(0)
  })
})

// ── getTopActionsByPriority ───────────────────────────────────

describe('getTopActionsByPriority', () => {
  it('limits to N per priority group', () => {
    const actions: TodayAction[] = [
      { account_id: 'a1', priority: 'P0', mrr_cents: 5000 } as TodayAction,
      { account_id: 'a2', priority: 'P0', mrr_cents: 4000 } as TodayAction,
      { account_id: 'a3', priority: 'P0', mrr_cents: 3000 } as TodayAction,
      { account_id: 'b1', priority: 'P1', mrr_cents: 2000 } as TodayAction,
      { account_id: 'b2', priority: 'P1', mrr_cents: 1000 } as TodayAction,
      { account_id: 'c1', priority: 'P2', mrr_cents: 500 } as TodayAction,
    ]
    const top = getTopActionsByPriority(actions, 2)
    expect(top.P0).toHaveLength(2)
    expect(top.P1).toHaveLength(2)
    expect(top.P2).toHaveLength(1) // only 1 available
  })

  it('returns empty groups when no actions', () => {
    const top = getTopActionsByPriority([], 5)
    expect(top.P0).toHaveLength(0)
    expect(top.P1).toHaveLength(0)
    expect(top.P2).toHaveLength(0)
  })

  it('sorts by MRR desc within each group', () => {
    const actions: TodayAction[] = [
      { account_id: 'a1', priority: 'P0', mrr_cents: 1000 } as TodayAction,
      { account_id: 'a2', priority: 'P0', mrr_cents: 5000 } as TodayAction,
    ]
    const top = getTopActionsByPriority(actions, 5)
    expect(top.P0[0].mrr_cents).toBe(5000)
    expect(top.P0[1].mrr_cents).toBe(1000)
  })
})

// ── Labels ────────────────────────────────────────────────────

describe('priorityLabel', () => {
  it('returns Critique for P0', () => expect(priorityLabel('P0')).toBe('Critique'))
  it('returns Haute for P1', () => expect(priorityLabel('P1')).toBe('Haute'))
  it('returns Normale for P2', () => expect(priorityLabel('P2')).toBe('Normale'))
})

describe('categoryLabel', () => {
  it('returns french label for known categories', () => {
    expect(categoryLabel('churn_prevention')).toBe('Prévention churn')
    expect(categoryLabel('expansion')).toBe('Expansion')
    expect(categoryLabel('onboarding')).toBe('Onboarding')
    expect(categoryLabel('renewal')).toBe('Renouvellement')
    expect(categoryLabel('winback')).toBe('Récupération')
  })

  it('returns raw value for unknown categories', () => {
    expect(categoryLabel('custom_category')).toBe('custom_category')
  })
})
