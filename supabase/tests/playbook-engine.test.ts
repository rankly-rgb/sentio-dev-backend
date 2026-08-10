import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  evaluateCondition,
  evaluateConditions,
  validatePlaybookActions,
  validateConditions,
  executeAction,
  calculateNextScheduledAt,
  isRecentExecution,
  calculateAttributionDeadline,
  deriveAttributionStatus,
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
  stripe_customer_id: 'cus_001',
  hubspot_company_id: null,
  display_name: 'Acme',
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
  is_delinquent: false,
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

  // Audit délinquence 2026-08-06, point 10 : is_delinquent doit être un champ
  // ciblable par eligibility_criteria — sans quoi un playbook de dunning est
  // impossible à écrire, malgré le signal correctement câblé côté scoring.
  it('eq: is_delinquent is targetable as an eligibility field (dunning playbook use case)', () => {
    const cond: Condition = { field: 'is_delinquent', operator: 'eq', value: true }
    expect(evaluateCondition(cond, { ...baseAccount, is_delinquent: true })).toBe(true)
    expect(evaluateCondition(cond, { ...baseAccount, is_delinquent: false })).toBe(false)
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

  // C2.5 (2026-08-02) : un eligibility_criteria vide/absent ne matche plus
  // rien par défaut — avant ce chantier, un playbook sans critères
  // s'exécutait silencieusement sur tous les comptes de l'org (voir
  // playbook-scheduler/playbook-execute, cas sans segment_id ni account_ids).

  it('returns false for null condition group (no more implicit match-all)', () => {
    expect(evaluateConditions(null, baseAccount)).toBe(false)
  })

  it('returns false for undefined condition group', () => {
    expect(evaluateConditions(undefined, baseAccount)).toBe(false)
  })

  it('returns false for empty conditions array without match_all', () => {
    const group: ConditionGroup = { operator: 'AND', conditions: [] }
    expect(evaluateConditions(group, baseAccount)).toBe(false)
  })

  it('returns true for empty conditions array with explicit match_all: true', () => {
    const group: ConditionGroup = { operator: 'AND', conditions: [], match_all: true }
    expect(evaluateConditions(group, baseAccount)).toBe(true)
  })

  it('match_all does not bypass non-empty conditions — they still gate matching', () => {
    const group: ConditionGroup = {
      operator: 'AND',
      conditions: [{ field: 'health_score', operator: 'gte', value: 999 }],
      match_all: true,
    }
    expect(evaluateConditions(group, baseAccount)).toBe(false)
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
    { type: 'log_note', config: { note: 'Risk flagged' }, order: 1 },
    { type: 'flag_for_review', config: {}, order: 2 },
  ]

  it('returns valid array for correct input', () => {
    const result = validatePlaybookActions(validActions)
    expect(result).toHaveLength(2)
    expect(result[0].type).toBe('log_note')
    expect(result[1].type).toBe('flag_for_review')
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
    const actions = [{ type: 'log_note', order: 1 }]
    expect(() => validatePlaybookActions(actions)).toThrow('actions[0].config must be an object')
  })

  it('throws for missing order', () => {
    const actions = [{ type: 'log_note', config: {} }]
    expect(() => validatePlaybookActions(actions)).toThrow('actions[0].order must be a positive integer')
  })

  it('throws for duplicate orders', () => {
    const actions = [
      { type: 'log_note', config: {}, order: 1 },
      { type: 'flag_for_review', config: {}, order: 1 },
    ]
    expect(() => validatePlaybookActions(actions)).toThrow('order 1 is duplicated')
  })

  it('throws for non-object config (array)', () => {
    const actions = [{ type: 'log_note', config: [1, 2], order: 1 }]
    expect(() => validatePlaybookActions(actions)).toThrow('actions[0].config must be an object')
  })

  it('throws for zero order', () => {
    const actions = [{ type: 'log_note', config: {}, order: 0 }]
    expect(() => validatePlaybookActions(actions)).toThrow('actions[0].order must be a positive integer')
  })

  it('throws for negative order', () => {
    const actions = [{ type: 'log_note', config: {}, order: -1 }]
    expect(() => validatePlaybookActions(actions)).toThrow('actions[0].order must be a positive integer')
  })

  it('throws for send_email missing email_subject', () => {
    const actions = [{ type: 'send_email', config: { email_body_html: '<p>body</p>' }, order: 1 }]
    expect(() => validatePlaybookActions(actions)).toThrow('email_subject must be a non-empty string')
  })

  it('throws for send_email with email_subject over 150 chars', () => {
    const actions = [{ type: 'send_email', config: { email_subject: 'x'.repeat(151), email_body_html: '<p>body</p>' }, order: 1 }]
    expect(() => validatePlaybookActions(actions)).toThrow('150 characters or less')
  })

  it('throws for send_email missing email_body_html', () => {
    const actions = [{ type: 'send_email', config: { email_subject: 'Subject' }, order: 1 }]
    expect(() => validatePlaybookActions(actions)).toThrow('email_body_html must be a non-empty string')
  })

  it('throws for send_email with email_body_html under 10 chars', () => {
    const actions = [{ type: 'send_email', config: { email_subject: 'Subject', email_body_html: 'short' }, order: 1 }]
    expect(() => validatePlaybookActions(actions)).toThrow('at least 10 characters')
  })

  it('accepts valid send_email action', () => {
    const actions = [{ type: 'send_email', config: { email_subject: 'Alert', email_body_html: '<p>Valid body content</p>' }, order: 1 }]
    const result = validatePlaybookActions(actions)
    expect(result[0].type).toBe('send_email')
  })

  it('accepts export_csv with empty config', () => {
    const actions = [{ type: 'export_csv', config: {}, order: 1 }]
    const result = validatePlaybookActions(actions)
    expect(result[0].type).toBe('export_csv')
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

  it('accepts explicit match_all: true (C2.5)', () => {
    const input = { operator: 'AND', conditions: [], match_all: true }
    const result = validateConditions(input)
    expect(result!.match_all).toBe(true)
  })

  it('omits match_all when not provided', () => {
    const input = { operator: 'AND', conditions: [{ field: 'x', operator: 'eq', value: 1 }] }
    const result = validateConditions(input)
    expect(result!.match_all).toBeUndefined()
  })

  it('throws for non-boolean match_all', () => {
    const input = { operator: 'AND', conditions: [], match_all: 'yes' }
    expect(() => validateConditions(input)).toThrow('conditions.match_all must be a boolean')
  })
})

// ── executeAction ───────────────────────────────────────────

describe('executeAction', () => {
  const context = { playbookId: 'pb-001', executionId: 'exec-001' }

  it('returns completed status for log_note', () => {
    const action: PlaybookAction = { type: 'log_note', config: { note: 'Risk flagged' }, order: 1 }
    const result = executeAction(action, baseAccount, context)
    expect(result.status).toBe('completed')
    expect(result.action_type).toBe('log_note')
    expect(result.order).toBe(1)
  })

  it('returns completed status for flag_for_review', () => {
    const action: PlaybookAction = { type: 'flag_for_review', config: {}, order: 2 }
    const result = executeAction(action, baseAccount, context)
    expect(result.status).toBe('completed')
    expect(result.action_type).toBe('flag_for_review')
  })

  it('returns completed status for export_csv', () => {
    const action: PlaybookAction = { type: 'export_csv', config: {}, order: 3 }
    const result = executeAction(action, baseAccount, context)
    expect(result.status).toBe('completed')
  })

  it('includes account id in message', () => {
    const action: PlaybookAction = { type: 'log_note', config: { note: 'test' }, order: 1 }
    const result = executeAction(action, baseAccount, context)
    expect(result.message).toContain('acc-001')
  })

  it('includes executed_at timestamp', () => {
    const action: PlaybookAction = { type: 'flag_for_review', config: {}, order: 1 }
    const result = executeAction(action, baseAccount, context)
    expect(result.executed_at).toBeDefined()
    expect(new Date(result.executed_at).getTime()).not.toBeNaN()
  })

  it('includes config in message', () => {
    const action: PlaybookAction = { type: 'log_note', config: { note: 'vip account' }, order: 1 }
    const result = executeAction(action, baseAccount, context)
    expect(result.message).toContain('"note":"vip account"')
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

// ── Playbook Outcome Tracking (chantier C) ───────────────────

describe('calculateAttributionDeadline', () => {
  it('adds attributionWindowDays days to executedAt', () => {
    const deadline = calculateAttributionDeadline('2026-07-01T00:00:00.000Z', 7)
    expect(deadline).toBe('2026-07-08T00:00:00.000Z')
  })

  it('defaults to 14 days when attributionWindowDays is null/undefined', () => {
    expect(calculateAttributionDeadline('2026-07-01T00:00:00.000Z', null)).toBe('2026-07-15T00:00:00.000Z')
    expect(calculateAttributionDeadline('2026-07-01T00:00:00.000Z', undefined)).toBe('2026-07-15T00:00:00.000Z')
  })

  it('accepts a Date instance', () => {
    const deadline = calculateAttributionDeadline(new Date('2026-07-01T00:00:00.000Z'), 1)
    expect(deadline).toBe('2026-07-02T00:00:00.000Z')
  })
})

describe('deriveAttributionStatus', () => {
  const now = new Date('2026-07-10T00:00:00.000Z')

  it('returns not_executed when marked_executed_at is null', () => {
    const status = deriveAttributionStatus({ marked_executed_at: null, account_converted: false, attribution_deadline_at: null }, now)
    expect(status).toBe('not_executed')
  })

  it('returns resolved when account_converted is true, regardless of deadline', () => {
    const status = deriveAttributionStatus(
      { marked_executed_at: '2026-07-01T00:00:00Z', account_converted: true, attribution_deadline_at: '2026-07-05T00:00:00Z' },
      now,
    )
    expect(status).toBe('resolved')
  })

  it('returns active when deadline is in the future and not converted', () => {
    const status = deriveAttributionStatus(
      { marked_executed_at: '2026-07-08T00:00:00Z', account_converted: false, attribution_deadline_at: '2026-07-20T00:00:00Z' },
      now,
    )
    expect(status).toBe('active')
  })

  it('returns expired when deadline is in the past and not converted', () => {
    const status = deriveAttributionStatus(
      { marked_executed_at: '2026-06-01T00:00:00Z', account_converted: false, attribution_deadline_at: '2026-07-01T00:00:00Z' },
      now,
    )
    expect(status).toBe('expired')
  })
})
