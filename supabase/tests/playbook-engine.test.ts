import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  evaluateCondition,
  evaluateConditions,
  validatePlaybookActions,
  validateConditions,
  executeAction,
  calculateNextScheduledAt,
  isRecentExecution,
  VALID_ACTION_TYPES,
  VALID_COMPARISON_OPERATORS,
  type Condition,
  type ConditionGroup,
  type PlaybookAction,
  type AccountData,
} from '../functions/_shared/playbook-engine'

// ── Test data ───────────────────────────────────────────────

const baseAccount: AccountData = {
  id: 'acc-001',
  organization_id: 'org-001',
  health_score: 65,
  churn_risk_score: 40,
  expansion_score: 55,
  product_usage_score: 70,
  mrr_cents: 150000,
  arr_cents: 1800000,
  plan_tier: 'growth',
  seat_count: 10,
  seat_limit: 20,
  contract_start_date: '2025-06-01',
  contract_end_date: '2026-06-01',
  created_at: '2025-06-01T00:00:00Z',
}

// ── evaluateCondition ───────────────────────────────────────

describe('evaluateCondition', () => {
  it('eq: returns true for matching values', () => {
    const cond: Condition = { field: 'plan_tier', operator: 'eq', value: 'growth' }
    expect(evaluateCondition(cond, baseAccount)).toBe(true)
  })

  it('eq: returns false for non-matching values', () => {
    const cond: Condition = { field: 'plan_tier', operator: 'eq', value: 'enterprise' }
    expect(evaluateCondition(cond, baseAccount)).toBe(false)
  })

  it('neq: returns true for different values', () => {
    const cond: Condition = { field: 'plan_tier', operator: 'neq', value: 'enterprise' }
    expect(evaluateCondition(cond, baseAccount)).toBe(true)
  })

  it('neq: returns false for same values', () => {
    const cond: Condition = { field: 'plan_tier', operator: 'neq', value: 'growth' }
    expect(evaluateCondition(cond, baseAccount)).toBe(false)
  })

  it('gt: returns true when actual > threshold', () => {
    const cond: Condition = { field: 'health_score', operator: 'gt', value: 60 }
    expect(evaluateCondition(cond, baseAccount)).toBe(true)
  })

  it('gt: returns false when actual <= threshold', () => {
    const cond: Condition = { field: 'health_score', operator: 'gt', value: 65 }
    expect(evaluateCondition(cond, baseAccount)).toBe(false)
  })

  it('gte: returns true when actual >= threshold', () => {
    const cond: Condition = { field: 'health_score', operator: 'gte', value: 65 }
    expect(evaluateCondition(cond, baseAccount)).toBe(true)
  })

  it('lt: returns true when actual < threshold', () => {
    const cond: Condition = { field: 'churn_risk_score', operator: 'lt', value: 50 }
    expect(evaluateCondition(cond, baseAccount)).toBe(true)
  })

  it('lte: returns true when actual <= threshold', () => {
    const cond: Condition = { field: 'churn_risk_score', operator: 'lte', value: 40 }
    expect(evaluateCondition(cond, baseAccount)).toBe(true)
  })

  it('in: returns true when value is in array', () => {
    const cond: Condition = { field: 'plan_tier', operator: 'in', value: ['growth', 'enterprise'] }
    expect(evaluateCondition(cond, baseAccount)).toBe(true)
  })

  it('in: returns false when value is not in array', () => {
    const cond: Condition = { field: 'plan_tier', operator: 'in', value: ['starter', 'enterprise'] }
    expect(evaluateCondition(cond, baseAccount)).toBe(false)
  })

  it('not_in: returns true when value is not in array', () => {
    const cond: Condition = { field: 'plan_tier', operator: 'not_in', value: ['starter', 'enterprise'] }
    expect(evaluateCondition(cond, baseAccount)).toBe(true)
  })

  it('not_in: returns false when value is in array', () => {
    const cond: Condition = { field: 'plan_tier', operator: 'not_in', value: ['growth', 'enterprise'] }
    expect(evaluateCondition(cond, baseAccount)).toBe(false)
  })

  it('returns false when field does not exist on account data', () => {
    const cond: Condition = { field: 'nonexistent_field', operator: 'eq', value: 42 }
    expect(evaluateCondition(cond, baseAccount)).toBe(false)
  })

  it('returns false when field value is null', () => {
    const account = { ...baseAccount, health_score: null }
    const cond: Condition = { field: 'health_score', operator: 'gte', value: 50 }
    expect(evaluateCondition(cond, account)).toBe(false)
  })

  it('gt: returns false for non-numeric values', () => {
    const cond: Condition = { field: 'plan_tier', operator: 'gt', value: 10 }
    expect(evaluateCondition(cond, baseAccount)).toBe(false)
  })

  it('in: returns false when condition value is not an array', () => {
    const cond: Condition = { field: 'plan_tier', operator: 'in', value: 'growth' }
    expect(evaluateCondition(cond, baseAccount)).toBe(false)
  })
})

// ── evaluateConditions ──────────────────────────────────────

describe('evaluateConditions', () => {
  it('AND: returns true when all conditions match', () => {
    const group: ConditionGroup = {
      operator: 'AND',
      conditions: [
        { field: 'health_score', operator: 'gte', value: 60 },
        { field: 'plan_tier', operator: 'eq', value: 'growth' },
      ],
    }
    expect(evaluateConditions(group, baseAccount)).toBe(true)
  })

  it('AND: returns false when any condition fails', () => {
    const group: ConditionGroup = {
      operator: 'AND',
      conditions: [
        { field: 'health_score', operator: 'gte', value: 80 },
        { field: 'plan_tier', operator: 'eq', value: 'growth' },
      ],
    }
    expect(evaluateConditions(group, baseAccount)).toBe(false)
  })

  it('OR: returns true when at least one condition matches', () => {
    const group: ConditionGroup = {
      operator: 'OR',
      conditions: [
        { field: 'health_score', operator: 'gte', value: 80 },
        { field: 'plan_tier', operator: 'eq', value: 'growth' },
      ],
    }
    expect(evaluateConditions(group, baseAccount)).toBe(true)
  })

  it('OR: returns false when no conditions match', () => {
    const group: ConditionGroup = {
      operator: 'OR',
      conditions: [
        { field: 'health_score', operator: 'gte', value: 80 },
        { field: 'plan_tier', operator: 'eq', value: 'enterprise' },
      ],
    }
    expect(evaluateConditions(group, baseAccount)).toBe(false)
  })

  it('returns true for null condition group', () => {
    expect(evaluateConditions(null, baseAccount)).toBe(true)
  })

  it('returns true for undefined condition group', () => {
    expect(evaluateConditions(undefined, baseAccount)).toBe(true)
  })

  it('returns true for empty conditions array', () => {
    const group: ConditionGroup = { operator: 'AND', conditions: [] }
    expect(evaluateConditions(group, baseAccount)).toBe(true)
  })

  it('handles mixed numeric and string conditions', () => {
    const group: ConditionGroup = {
      operator: 'AND',
      conditions: [
        { field: 'mrr_cents', operator: 'gte', value: 100000 },
        { field: 'plan_tier', operator: 'in', value: ['growth', 'enterprise'] },
        { field: 'churn_risk_score', operator: 'lt', value: 50 },
      ],
    }
    expect(evaluateConditions(group, baseAccount)).toBe(true)
  })
})

// ── validatePlaybookActions ─────────────────────────────────

describe('validatePlaybookActions', () => {
  const validActions: PlaybookAction[] = [
    { type: 'slack_notify', config: { channel: '#cs-team' }, order: 1 },
    { type: 'create_task', config: { title: 'Follow up' }, order: 2 },
  ]

  it('returns valid array for correct input', () => {
    const result = validatePlaybookActions(validActions)
    expect(result).toHaveLength(2)
    expect(result[0].type).toBe('slack_notify')
    expect(result[1].type).toBe('create_task')
  })

  it('throws for non-array input', () => {
    expect(() => validatePlaybookActions('not an array')).toThrow('must be a non-empty array')
  })

  it('throws for empty array', () => {
    expect(() => validatePlaybookActions([])).toThrow('must be a non-empty array')
  })

  it('throws for invalid action type', () => {
    const actions = [{ type: 'invalid_type', config: {}, order: 1 }]
    expect(() => validatePlaybookActions(actions)).toThrow('actions[0].type must be one of')
  })

  it('throws for missing config', () => {
    const actions = [{ type: 'slack_notify', order: 1 }]
    expect(() => validatePlaybookActions(actions)).toThrow('actions[0].config must be an object')
  })

  it('throws for missing order', () => {
    const actions = [{ type: 'slack_notify', config: {} }]
    expect(() => validatePlaybookActions(actions)).toThrow('actions[0].order must be a positive integer')
  })

  it('throws for duplicate orders', () => {
    const actions = [
      { type: 'slack_notify', config: {}, order: 1 },
      { type: 'create_task', config: {}, order: 1 },
    ]
    expect(() => validatePlaybookActions(actions)).toThrow('order 1 is duplicated')
  })

  it('throws for non-object config (array)', () => {
    const actions = [{ type: 'slack_notify', config: [1, 2], order: 1 }]
    expect(() => validatePlaybookActions(actions)).toThrow('actions[0].config must be an object')
  })

  it('throws for zero order', () => {
    const actions = [{ type: 'slack_notify', config: {}, order: 0 }]
    expect(() => validatePlaybookActions(actions)).toThrow('actions[0].order must be a positive integer')
  })

  it('throws for negative order', () => {
    const actions = [{ type: 'slack_notify', config: {}, order: -1 }]
    expect(() => validatePlaybookActions(actions)).toThrow('actions[0].order must be a positive integer')
  })
})

// ── validateConditions ──────────────────────────────────────

describe('validateConditions', () => {
  it('returns null for null input', () => {
    expect(validateConditions(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(validateConditions(undefined)).toBeNull()
  })

  it('returns valid ConditionGroup for correct input', () => {
    const input = {
      operator: 'AND',
      conditions: [
        { field: 'health_score', operator: 'gte', value: 50 },
      ],
    }
    const result = validateConditions(input)
    expect(result).not.toBeNull()
    expect(result!.operator).toBe('AND')
    expect(result!.conditions).toHaveLength(1)
    expect(result!.conditions[0].field).toBe('health_score')
  })

  it('throws for missing operator', () => {
    const input = { conditions: [{ field: 'x', operator: 'eq', value: 1 }] }
    expect(() => validateConditions(input)).toThrow('conditions.operator must be "AND" or "OR"')
  })

  it('throws for invalid operator', () => {
    const input = { operator: 'XOR', conditions: [] }
    expect(() => validateConditions(input)).toThrow('conditions.operator must be "AND" or "OR"')
  })

  it('throws for missing conditions array', () => {
    const input = { operator: 'AND' }
    expect(() => validateConditions(input)).toThrow('conditions.conditions must be an array')
  })

  it('throws for condition with invalid comparison operator', () => {
    const input = {
      operator: 'AND',
      conditions: [{ field: 'x', operator: 'like', value: '%test%' }],
    }
    expect(() => validateConditions(input)).toThrow('conditions.conditions[0].operator must be one of')
  })

  it('throws for condition with missing field', () => {
    const input = {
      operator: 'AND',
      conditions: [{ operator: 'eq', value: 1 }],
    }
    expect(() => validateConditions(input)).toThrow('conditions.conditions[0].field must be a non-empty string')
  })

  it('throws for condition with missing value', () => {
    const input = {
      operator: 'AND',
      conditions: [{ field: 'x', operator: 'eq' }],
    }
    expect(() => validateConditions(input)).toThrow('conditions.conditions[0].value is required')
  })

  it('throws for non-object input', () => {
    expect(() => validateConditions('string')).toThrow('conditions must be an object')
  })

  it('accepts OR operator', () => {
    const input = {
      operator: 'OR',
      conditions: [{ field: 'x', operator: 'eq', value: 1 }],
    }
    const result = validateConditions(input)
    expect(result!.operator).toBe('OR')
  })
})

// ── executeAction ───────────────────────────────────────────

describe('executeAction', () => {
  const context = { playbookId: 'pb-001', executionId: 'exec-001' }

  it('returns completed status for slack_notify', () => {
    const action: PlaybookAction = { type: 'slack_notify', config: { channel: '#cs-team' }, order: 1 }
    const result = executeAction(action, baseAccount, context)
    expect(result.status).toBe('completed')
    expect(result.action_type).toBe('slack_notify')
    expect(result.order).toBe(1)
  })

  it('returns completed status for create_task', () => {
    const action: PlaybookAction = { type: 'create_task', config: { title: 'Follow up' }, order: 2 }
    const result = executeAction(action, baseAccount, context)
    expect(result.status).toBe('completed')
    expect(result.action_type).toBe('create_task')
  })

  it('returns completed status for flag_for_review', () => {
    const action: PlaybookAction = { type: 'flag_for_review', config: {}, order: 3 }
    const result = executeAction(action, baseAccount, context)
    expect(result.status).toBe('completed')
  })

  it('includes account id in message', () => {
    const action: PlaybookAction = { type: 'log_note', config: { note: 'test' }, order: 1 }
    const result = executeAction(action, baseAccount, context)
    expect(result.message).toContain('acc-001')
  })

  it('includes executed_at timestamp', () => {
    const action: PlaybookAction = { type: 'assign_owner', config: { role: 'csm' }, order: 1 }
    const result = executeAction(action, baseAccount, context)
    expect(result.executed_at).toBeDefined()
    expect(new Date(result.executed_at).getTime()).not.toBeNaN()
  })

  it('includes config in message', () => {
    const action: PlaybookAction = { type: 'update_tag', config: { tag: 'vip' }, order: 1 }
    const result = executeAction(action, baseAccount, context)
    expect(result.message).toContain('"tag":"vip"')
  })

  it('works for all valid action types', () => {
    for (const type of VALID_ACTION_TYPES) {
      const action: PlaybookAction = { type, config: {}, order: 1 }
      const result = executeAction(action, baseAccount, context)
      expect(result.status).toBe('completed')
      expect(result.action_type).toBe(type)
    }
  })
})

// ── calculateNextScheduledAt ────────────────────────────────

describe('calculateNextScheduledAt', () => {
  const baseDate = new Date('2026-03-01T12:00:00Z')

  it('adds 24 hours for daily frequency', () => {
    const result = calculateNextScheduledAt('daily', baseDate)
    const next = new Date(result)
    expect(next.getTime() - baseDate.getTime()).toBe(24 * 60 * 60 * 1000)
  })

  it('adds 7 days for weekly frequency', () => {
    const result = calculateNextScheduledAt('weekly', baseDate)
    const next = new Date(result)
    expect(next.getTime() - baseDate.getTime()).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('adds 30 days for monthly frequency', () => {
    const result = calculateNextScheduledAt('monthly', baseDate)
    const next = new Date(result)
    expect(next.getTime() - baseDate.getTime()).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('uses current date when fromDate not provided', () => {
    const before = Date.now()
    const result = calculateNextScheduledAt('daily')
    const next = new Date(result).getTime()
    const after = Date.now()
    // Should be ~24h from now
    expect(next).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 100)
    expect(next).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000 + 100)
  })
})

// ── isRecentExecution ───────────────────────────────────────

describe('isRecentExecution', () => {
  it('returns false for null lastExecutedAt', () => {
    expect(isRecentExecution(null, 24)).toBe(false)
  })

  it('returns true when last execution is within cooldown', () => {
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
    expect(isRecentExecution(oneHourAgo, 24)).toBe(true)
  })

  it('returns false when last execution is outside cooldown', () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    expect(isRecentExecution(twoDaysAgo, 24)).toBe(false)
  })

  it('returns false for exactly at cooldown boundary', () => {
    const exactlyAtCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    expect(isRecentExecution(exactlyAtCutoff, 24)).toBe(false)
  })
})
