import { describe, it, expect } from 'vitest'
import {
  classifyUrgency,
  classifyUrgencyFr,
  buildAffectedAccountsSummary,
  buildConditionLabel,
  buildConditionsDisplay,
  buildActionsDisplay,
  isTransitionAllowed,
  getAllowedTransitions,
  computeExecutionStats,
  buildEligibleAccountsSummary,
  buildEligibleAccountRow,
  type AccountForSummary,
  type ExecutionStatsInput,
  type EligibleAccountRow,
} from '../functions/_shared/playbook-detail-helpers'
import type { Condition, ConditionGroup, PlaybookAction } from '../functions/_shared/playbook-engine'

// ── classifyUrgency ──────────────────────────────────────────

describe('classifyUrgency', () => {
  it('returns urgent for churn_risk >= 70', () => {
    expect(classifyUrgency(70)).toBe('urgent')
    expect(classifyUrgency(100)).toBe('urgent')
  })

  it('returns watch for churn_risk 40-69', () => {
    expect(classifyUrgency(40)).toBe('watch')
    expect(classifyUrgency(69)).toBe('watch')
  })

  it('returns stable for churn_risk < 40', () => {
    expect(classifyUrgency(39)).toBe('stable')
    expect(classifyUrgency(0)).toBe('stable')
  })

  it('returns stable for null', () => {
    expect(classifyUrgency(null)).toBe('stable')
  })

  it('boundary: 70 is urgent, 69 is watch', () => {
    expect(classifyUrgency(70)).toBe('urgent')
    expect(classifyUrgency(69)).toBe('watch')
  })

  it('boundary: 40 is watch, 39 is stable', () => {
    expect(classifyUrgency(40)).toBe('watch')
    expect(classifyUrgency(39)).toBe('stable')
  })
})

// ── buildAffectedAccountsSummary ─────────────────────────────

describe('buildAffectedAccountsSummary', () => {
  it('computes summary for mixed urgency accounts', () => {
    const accounts: AccountForSummary[] = [
      { churn_risk_score: 80, mrr_cents: 50000 },
      { churn_risk_score: 50, mrr_cents: 30000 },
      { churn_risk_score: 20, mrr_cents: 10000 },
    ]
    const result = buildAffectedAccountsSummary(accounts)
    expect(result.total).toBe(3)
    expect(result.mrr_at_risk_cents).toBe(90000)
    expect(result.by_urgency.urgent).toBe(1)
    expect(result.by_urgency.watch).toBe(1)
    expect(result.by_urgency.stable).toBe(1)
  })

  it('handles empty accounts', () => {
    const result = buildAffectedAccountsSummary([])
    expect(result.total).toBe(0)
    expect(result.mrr_at_risk_cents).toBe(0)
    expect(result.by_urgency.urgent).toBe(0)
    expect(result.by_urgency.watch).toBe(0)
    expect(result.by_urgency.stable).toBe(0)
  })

  it('handles null mrr_cents', () => {
    const accounts: AccountForSummary[] = [
      { churn_risk_score: 80, mrr_cents: null },
    ]
    const result = buildAffectedAccountsSummary(accounts)
    expect(result.total).toBe(1)
    expect(result.mrr_at_risk_cents).toBe(0)
  })

  it('handles null churn_risk_score as stable', () => {
    const accounts: AccountForSummary[] = [
      { churn_risk_score: null, mrr_cents: 10000 },
    ]
    const result = buildAffectedAccountsSummary(accounts)
    expect(result.by_urgency.stable).toBe(1)
  })
})

// ── buildConditionLabel ──────────────────────────────────────

describe('buildConditionLabel', () => {
  it('generates label for churn_risk_score gte', () => {
    const cond: Condition = { field: 'churn_risk_score', operator: 'gte', value: 70 }
    expect(buildConditionLabel(cond)).toBe('Score de risque churn ≥ 70')
  })

  it('generates label for mrr_cents gte (converts to euros)', () => {
    const cond: Condition = { field: 'mrr_cents', operator: 'gte', value: 50000 }
    expect(buildConditionLabel(cond)).toBe('MRR ≥ 500 €')
  })

  it('generates label for plan_tier in', () => {
    const cond: Condition = { field: 'plan_tier', operator: 'in', value: ['growth', 'enterprise'] }
    expect(buildConditionLabel(cond)).toBe('Plan parmi growth, enterprise')
  })

  it('handles unknown field', () => {
    const cond: Condition = { field: 'custom_field', operator: 'eq', value: 42 }
    expect(buildConditionLabel(cond)).toBe('custom_field = 42')
  })

  it('generates label for health_score lte', () => {
    const cond: Condition = { field: 'health_score', operator: 'lte', value: 40 }
    expect(buildConditionLabel(cond)).toBe('Score de santé ≤ 40')
  })
})

// ── buildConditionsDisplay ───────────────────────────────────

describe('buildConditionsDisplay', () => {
  it('returns empty array for null criteria', () => {
    expect(buildConditionsDisplay(null)).toEqual([])
  })

  it('returns empty array for undefined criteria', () => {
    expect(buildConditionsDisplay(undefined)).toEqual([])
  })

  it('converts conditions with labels', () => {
    const criteria: ConditionGroup = {
      operator: 'AND',
      conditions: [
        { field: 'churn_risk_score', operator: 'gte', value: 70 },
        { field: 'plan_tier', operator: 'in', value: ['growth'] },
      ],
    }
    const result = buildConditionsDisplay(criteria)
    expect(result).toHaveLength(2)
    expect(result[0].field).toBe('churn_risk_score')
    expect(result[0].label).toContain('≥ 70')
    expect(result[1].field).toBe('plan_tier')
    expect(result[1].label).toContain('parmi')
  })
})

// ── buildActionsDisplay ──────────────────────────────────────

describe('buildActionsDisplay', () => {
  it('returns empty array for null actions', () => {
    expect(buildActionsDisplay(null)).toEqual([])
  })

  it('returns empty array for undefined actions', () => {
    expect(buildActionsDisplay(undefined)).toEqual([])
  })

  it('builds display with step, type, label, detail', () => {
    const actions: PlaybookAction[] = [
      { type: 'slack_notify', config: { channel: '#cs-team', template: 'churn_alert' }, order: 1 },
      { type: 'create_task', config: { title: 'Follow up call' }, order: 2 },
    ]
    const result = buildActionsDisplay(actions)
    expect(result).toHaveLength(2)
    expect(result[0].step).toBe(1)
    expect(result[0].type).toBe('slack_notify')
    expect(result[0].label).toBe('Notification Slack')
    expect(result[0].detail).toBe('#cs-team — churn_alert')
    expect(result[1].step).toBe(2)
    expect(result[1].label).toBe('Créer une tâche')
    expect(result[1].detail).toBe('Follow up call')
  })

  it('sorts by order', () => {
    const actions: PlaybookAction[] = [
      { type: 'create_task', config: { title: 'B' }, order: 2 },
      { type: 'slack_notify', config: { channel: '#a' }, order: 1 },
    ]
    const result = buildActionsDisplay(actions)
    expect(result[0].step).toBe(1)
    expect(result[1].step).toBe(2)
  })

  it('handles flag_for_review with empty detail', () => {
    const actions: PlaybookAction[] = [
      { type: 'flag_for_review', config: {}, order: 1 },
    ]
    const result = buildActionsDisplay(actions)
    expect(result[0].label).toBe('Signaler pour revue')
    expect(result[0].detail).toBe('')
  })
})

// ── isTransitionAllowed ──────────────────────────────────────

describe('isTransitionAllowed', () => {
  it('draft → active is allowed', () => {
    expect(isTransitionAllowed('draft', 'active')).toBe(true)
  })

  it('draft → archived is allowed', () => {
    expect(isTransitionAllowed('draft', 'archived')).toBe(true)
  })

  it('active → draft is allowed', () => {
    expect(isTransitionAllowed('active', 'draft')).toBe(true)
  })

  it('active → archived is allowed', () => {
    expect(isTransitionAllowed('active', 'archived')).toBe(true)
  })

  it('archived → active is NOT allowed', () => {
    expect(isTransitionAllowed('archived', 'active')).toBe(false)
  })

  it('archived → draft is NOT allowed', () => {
    expect(isTransitionAllowed('archived', 'draft')).toBe(false)
  })

  it('paused → active is allowed', () => {
    expect(isTransitionAllowed('paused', 'active')).toBe(true)
  })

  it('completed → archived is allowed', () => {
    expect(isTransitionAllowed('completed', 'archived')).toBe(true)
  })

  it('completed → active is NOT allowed', () => {
    expect(isTransitionAllowed('completed', 'active')).toBe(false)
  })

  it('unknown status returns false', () => {
    expect(isTransitionAllowed('unknown', 'active')).toBe(false)
  })
})

// ── getAllowedTransitions ────────────────────────────────────

describe('getAllowedTransitions', () => {
  it('returns allowed targets for draft', () => {
    expect(getAllowedTransitions('draft')).toEqual(['active', 'archived'])
  })

  it('returns empty array for archived', () => {
    expect(getAllowedTransitions('archived')).toEqual([])
  })

  it('returns empty array for unknown status', () => {
    expect(getAllowedTransitions('nonexistent')).toEqual([])
  })
})

// ── computeExecutionStats ────────────────────────────────────

describe('computeExecutionStats', () => {
  it('computes stats for mixed executions', () => {
    const executions: ExecutionStatsInput[] = [
      { execution_status: 'completed', account_id: 'a1', account_converted: true, mrr_recovered_cents: 5000, mrr_expansion_cents: 0 },
      { execution_status: 'completed', account_id: 'a2', account_converted: false, mrr_recovered_cents: 0, mrr_expansion_cents: 3000 },
      { execution_status: 'failed', account_id: 'a3', account_converted: false, mrr_recovered_cents: 0, mrr_expansion_cents: 0 },
      { execution_status: 'running', account_id: 'a4', account_converted: false, mrr_recovered_cents: 0, mrr_expansion_cents: 0 },
    ]
    const stats = computeExecutionStats(executions)
    expect(stats.targeted_count).toBe(4)
    expect(stats.reached_count).toBe(3) // completed + running
    expect(stats.converted_count).toBe(1)
    expect(stats.mrr_recovered_cents).toBe(5000)
    expect(stats.mrr_expansion_cents).toBe(3000)
    expect(stats.executions_total).toBe(4)
    expect(stats.executions_completed).toBe(2)
    expect(stats.executions_failed).toBe(1)
    expect(stats.executions_in_progress).toBe(1)
  })

  it('returns zeros for empty executions', () => {
    const stats = computeExecutionStats([])
    expect(stats.targeted_count).toBe(0)
    expect(stats.reached_count).toBe(0)
    expect(stats.converted_count).toBe(0)
    expect(stats.mrr_recovered_cents).toBe(0)
    expect(stats.mrr_expansion_cents).toBe(0)
    expect(stats.executions_total).toBe(0)
  })

  it('deduplicates accounts for targeted_count', () => {
    const executions: ExecutionStatsInput[] = [
      { execution_status: 'completed', account_id: 'a1', account_converted: false },
      { execution_status: 'failed', account_id: 'a1', account_converted: false },
    ]
    const stats = computeExecutionStats(executions)
    expect(stats.targeted_count).toBe(1)
    expect(stats.executions_total).toBe(2)
  })

  it('mrr_recovered_cents is 0 when no completed executions have recovery', () => {
    const executions: ExecutionStatsInput[] = [
      { execution_status: 'pending', account_id: 'a1' },
      { execution_status: 'running', account_id: 'a2' },
    ]
    const stats = computeExecutionStats(executions)
    expect(stats.mrr_recovered_cents).toBe(0)
    expect(stats.executions_in_progress).toBe(2)
  })

  it('handles null mrr fields', () => {
    const executions: ExecutionStatsInput[] = [
      { execution_status: 'completed', account_id: 'a1', mrr_recovered_cents: null, mrr_expansion_cents: null },
    ]
    const stats = computeExecutionStats(executions)
    expect(stats.mrr_recovered_cents).toBe(0)
    expect(stats.mrr_expansion_cents).toBe(0)
  })

  it('counts pending as in_progress', () => {
    const executions: ExecutionStatsInput[] = [
      { execution_status: 'pending', account_id: 'a1' },
    ]
    const stats = computeExecutionStats(executions)
    expect(stats.executions_in_progress).toBe(1)
  })
})

// ── classifyUrgencyFr ───────────────────────────────────────

describe('classifyUrgencyFr', () => {
  it('returns urgent for churn >= 70', () => {
    expect(classifyUrgencyFr(70)).toBe('urgent')
    expect(classifyUrgencyFr(100)).toBe('urgent')
  })

  it('returns surveiller for churn 40-69', () => {
    expect(classifyUrgencyFr(40)).toBe('surveiller')
    expect(classifyUrgencyFr(69)).toBe('surveiller')
  })

  it('returns stable for churn < 40', () => {
    expect(classifyUrgencyFr(39)).toBe('stable')
    expect(classifyUrgencyFr(0)).toBe('stable')
  })

  it('returns stable for null', () => {
    expect(classifyUrgencyFr(null)).toBe('stable')
  })

  it('boundary: 70 is urgent, 69 is surveiller', () => {
    expect(classifyUrgencyFr(70)).toBe('urgent')
    expect(classifyUrgencyFr(69)).toBe('surveiller')
  })

  it('boundary: 40 is surveiller, 39 is stable', () => {
    expect(classifyUrgencyFr(40)).toBe('surveiller')
    expect(classifyUrgencyFr(39)).toBe('stable')
  })
})

// ── buildEligibleAccountRow ─────────────────────────────────

describe('buildEligibleAccountRow', () => {
  it('builds row from account with id field', () => {
    const row = buildEligibleAccountRow({
      id: 'acc-1',
      stripe_customer_id: 'cus_123',
      mrr_cents: 5000,
      churn_risk_score: 75,
      health_score: 40,
      expansion_score: 30,
    })
    expect(row.account_id).toBe('acc-1')
    expect(row.stripe_customer_id).toBe('cus_123')
    expect(row.mrr_cents).toBe(5000)
    expect(row.urgency).toBe('urgent')
  })

  it('builds row from account with account_id field', () => {
    const row = buildEligibleAccountRow({
      account_id: 'acc-2',
      stripe_customer_id: 'cus_456',
      mrr_cents: 3000,
      churn_risk_score: 50,
      health_score: 60,
      expansion_score: 70,
    })
    expect(row.account_id).toBe('acc-2')
    expect(row.urgency).toBe('surveiller')
  })

  it('handles null values', () => {
    const row = buildEligibleAccountRow({
      id: 'acc-3',
      stripe_customer_id: null,
      mrr_cents: null,
      churn_risk_score: null,
      health_score: null,
      expansion_score: null,
    })
    expect(row.stripe_customer_id).toBeNull()
    expect(row.mrr_cents).toBeNull()
    expect(row.urgency).toBe('stable')
  })

  it('uses pre-computed urgency from RPC when provided', () => {
    const row = buildEligibleAccountRow({
      account_id: 'acc-4',
      churn_risk_score: 80,
      urgency: 'surveiller', // Override computed value
    })
    expect(row.urgency).toBe('surveiller')
  })

  it('zero-PII: no email, name, phone in output', () => {
    const row = buildEligibleAccountRow({
      id: 'acc-5',
      stripe_customer_id: 'cus_789',
      mrr_cents: 1000,
      churn_risk_score: 20,
      health_score: 80,
      expansion_score: 60,
    })
    const keys = Object.keys(row)
    expect(keys).not.toContain('email')
    expect(keys).not.toContain('name')
    expect(keys).not.toContain('phone')
    expect(keys).toContain('stripe_customer_id')
  })
})

// ── buildEligibleAccountsSummary ────────────────────────────

describe('buildEligibleAccountsSummary', () => {
  it('computes summary for mixed urgency accounts', () => {
    const accounts: EligibleAccountRow[] = [
      { account_id: 'a1', stripe_customer_id: 'cus_1', mrr_cents: 10000, churn_risk_score: 80, health_score: 30, expansion_score: 10, urgency: 'urgent' },
      { account_id: 'a2', stripe_customer_id: 'cus_2', mrr_cents: 5000, churn_risk_score: 55, health_score: 50, expansion_score: 40, urgency: 'surveiller' },
      { account_id: 'a3', stripe_customer_id: 'cus_3', mrr_cents: 3000, churn_risk_score: 20, health_score: 80, expansion_score: 70, urgency: 'stable' },
    ]
    const summary = buildEligibleAccountsSummary(accounts)
    expect(summary.total).toBe(3)
    expect(summary.mrr_at_risk_cents).toBe(18000)
    expect(summary.urgent_count).toBe(1)
    expect(summary.surveiller_count).toBe(1)
    expect(summary.stable_count).toBe(1)
  })

  it('returns zeros for empty array', () => {
    const summary = buildEligibleAccountsSummary([])
    expect(summary.total).toBe(0)
    expect(summary.mrr_at_risk_cents).toBe(0)
    expect(summary.urgent_count).toBe(0)
    expect(summary.surveiller_count).toBe(0)
    expect(summary.stable_count).toBe(0)
  })

  it('handles null mrr_cents', () => {
    const accounts: EligibleAccountRow[] = [
      { account_id: 'a1', stripe_customer_id: 'cus_1', mrr_cents: null, churn_risk_score: 85, health_score: 20, expansion_score: 5, urgency: 'urgent' },
    ]
    const summary = buildEligibleAccountsSummary(accounts)
    expect(summary.mrr_at_risk_cents).toBe(0)
    expect(summary.urgent_count).toBe(1)
  })

  it('all accounts same urgency', () => {
    const accounts: EligibleAccountRow[] = [
      { account_id: 'a1', stripe_customer_id: 'cus_1', mrr_cents: 1000, churn_risk_score: 75, health_score: 30, expansion_score: 10, urgency: 'urgent' },
      { account_id: 'a2', stripe_customer_id: 'cus_2', mrr_cents: 2000, churn_risk_score: 90, health_score: 10, expansion_score: 5, urgency: 'urgent' },
    ]
    const summary = buildEligibleAccountsSummary(accounts)
    expect(summary.urgent_count).toBe(2)
    expect(summary.surveiller_count).toBe(0)
    expect(summary.stable_count).toBe(0)
  })

  it('falls back to classifyUrgencyFr when urgency not set', () => {
    const accounts: EligibleAccountRow[] = [
      { account_id: 'a1', stripe_customer_id: 'cus_1', mrr_cents: 5000, churn_risk_score: 80, health_score: 20, expansion_score: 5, urgency: '' as 'urgent' },
    ]
    const summary = buildEligibleAccountsSummary(accounts)
    // Empty urgency falls through to classifyUrgencyFr(80) = 'urgent'
    expect(summary.urgent_count).toBe(1)
  })
})
