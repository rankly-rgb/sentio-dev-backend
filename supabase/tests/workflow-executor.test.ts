import { describe, it, expect, vi, beforeEach } from 'vitest'
import { interpolateTemplate } from '../functions/_shared/workflow-executor'
import type { WorkflowStepContext } from '../functions/_shared/workflow-executor'
import type { AccountData, WorkflowStep } from '../functions/_shared/playbook-engine'

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

const baseContext: WorkflowStepContext = {
  playbookId: 'pb-001',
  executionId: 'exec-001',
  csmEmail: 'csm@example.com',
  csmName: 'Jean Dupont',
  orgName: 'Acme Corp',
}

// ── interpolateTemplate ─────────────────────────────────────

describe('interpolateTemplate', () => {
  it('returns empty string for empty template', () => {
    expect(interpolateTemplate('', baseAccount, baseContext)).toBe('')
  })

  it('returns empty string for null-ish template', () => {
    expect(interpolateTemplate(null as unknown as string, baseAccount, baseContext)).toBe('')
    expect(interpolateTemplate(undefined as unknown as string, baseAccount, baseContext)).toBe('')
  })

  it('replaces {{account.health_score}}', () => {
    const result = interpolateTemplate('Score: {{account.health_score}}', baseAccount, baseContext)
    expect(result).toBe('Score: 65')
  })

  it('replaces {{account.churn_risk_score}}', () => {
    const result = interpolateTemplate('Risk: {{account.churn_risk_score}}%', baseAccount, baseContext)
    expect(result).toBe('Risk: 40%')
  })

  it('replaces {{account.plan_tier}} (string field)', () => {
    const result = interpolateTemplate('Plan: {{account.plan_tier}}', baseAccount, baseContext)
    expect(result).toBe('Plan: growth')
  })

  it('replaces {{account.mrr_eur}} with cents-to-euros conversion', () => {
    const result = interpolateTemplate('MRR: {{account.mrr_eur}}€', baseAccount, baseContext)
    expect(result).toBe('MRR: 1500€')
  })

  it('replaces {{account.arr_eur}} with cents-to-euros conversion', () => {
    const result = interpolateTemplate('ARR: {{account.arr_eur}}€', baseAccount, baseContext)
    expect(result).toBe('ARR: 18000€')
  })

  it('replaces {{account.seat_usage_pct}} with percentage', () => {
    // seat_count=10, seat_limit=20 → 50%
    const result = interpolateTemplate('Seats: {{account.seat_usage_pct}}%', baseAccount, baseContext)
    expect(result).toBe('Seats: 50%')
  })

  it('handles seat_usage_pct when seat_limit is 0', () => {
    const account = { ...baseAccount, seat_limit: 0 }
    const result = interpolateTemplate('Seats: {{account.seat_usage_pct}}%', account, baseContext)
    expect(result).toBe('Seats: 0%')
  })

  it('handles seat_usage_pct when seat_limit is null', () => {
    const account = { ...baseAccount, seat_limit: null } as unknown as AccountData
    const result = interpolateTemplate('Seats: {{account.seat_usage_pct}}%', account, baseContext)
    expect(result).toBe('Seats: 0%')
  })

  it('replaces {{org.name}}', () => {
    const result = interpolateTemplate('Org: {{org.name}}', baseAccount, baseContext)
    expect(result).toBe('Org: Acme Corp')
  })

  it('replaces {{csm.name}}', () => {
    const result = interpolateTemplate('CSM: {{csm.name}}', baseAccount, baseContext)
    expect(result).toBe('CSM: Jean Dupont')
  })

  it('replaces {{csm.email}}', () => {
    const result = interpolateTemplate('Email: {{csm.email}}', baseAccount, baseContext)
    expect(result).toBe('Email: csm@example.com')
  })

  it('handles missing csm.name (undefined)', () => {
    const ctx = { ...baseContext, csmName: undefined }
    const result = interpolateTemplate('CSM: {{csm.name}}', baseAccount, ctx)
    expect(result).toBe('CSM: ')
  })

  it('handles missing org.name (empty string)', () => {
    const ctx = { ...baseContext, orgName: '' }
    const result = interpolateTemplate('Org: {{org.name}}', baseAccount, ctx)
    expect(result).toBe('Org: ')
  })

  it('handles null account fields gracefully', () => {
    const account = { ...baseAccount, health_score: null } as unknown as AccountData
    const result = interpolateTemplate('Score: {{account.health_score}}', account, baseContext)
    expect(result).toBe('Score: ')
  })

  it('handles undefined account fields gracefully', () => {
    const account = { ...baseAccount } as unknown as Record<string, unknown>
    delete account.health_score
    const result = interpolateTemplate(
      'Score: {{account.health_score}}',
      account as unknown as AccountData,
      baseContext,
    )
    expect(result).toBe('Score: ')
  })

  it('replaces multiple variables in one template', () => {
    const template = 'Bonjour {{csm.name}}, le compte {{account.plan_tier}} ({{account.mrr_eur}}€) chez {{org.name}} a un score de {{account.health_score}}/100.'
    const result = interpolateTemplate(template, baseAccount, baseContext)
    expect(result).toBe(
      'Bonjour Jean Dupont, le compte growth (1500€) chez Acme Corp a un score de 65/100.',
    )
  })

  it('handles repeated variables', () => {
    const result = interpolateTemplate(
      '{{org.name}} - {{org.name}}',
      baseAccount,
      baseContext,
    )
    expect(result).toBe('Acme Corp - Acme Corp')
  })

  it('leaves unrecognized patterns as-is', () => {
    const result = interpolateTemplate('Hello {{unknown.var}}', baseAccount, baseContext)
    expect(result).toBe('Hello {{unknown.var}}')
  })

  it('handles mrr_cents = 0', () => {
    const account = { ...baseAccount, mrr_cents: 0 }
    const result = interpolateTemplate('MRR: {{account.mrr_eur}}€', account, baseContext)
    expect(result).toBe('MRR: 0€')
  })

  it('handles mrr_cents = null', () => {
    const account = { ...baseAccount, mrr_cents: null } as unknown as AccountData
    const result = interpolateTemplate('MRR: {{account.mrr_eur}}€', account, baseContext)
    expect(result).toBe('MRR: 0€')
  })

  it('replaces {{account.contract_end_date}} (date field)', () => {
    const result = interpolateTemplate(
      'Contrat expire le {{account.contract_end_date}}',
      baseAccount,
      baseContext,
    )
    expect(result).toBe('Contrat expire le 2026-06-01')
  })

  it('handles HTML template with variables', () => {
    const html = '<h1>Alerte pour {{org.name}}</h1><p>Score: {{account.health_score}}</p>'
    const result = interpolateTemplate(html, baseAccount, baseContext)
    expect(result).toBe('<h1>Alerte pour Acme Corp</h1><p>Score: 65</p>')
  })
})

// ── validateWorkflowSteps ────────────────────────────────────

import { validateWorkflowSteps, calculateStepDueDate } from '../functions/_shared/playbook-engine'

describe('validateWorkflowSteps', () => {
  const validStep: WorkflowStep = {
    step_order: 1,
    delay_days: 0,
    action_type: 'send_email',
    title: 'Email initial',
    config: {
      email_subject: 'Alerte',
      email_body_html: '<p>Bonjour</p>',
    },
  }

  it('validates a single valid step', () => {
    const result = validateWorkflowSteps([validStep])
    expect(result).toHaveLength(1)
    expect(result[0].step_order).toBe(1)
  })

  it('validates multiple steps', () => {
    const steps = [
      validStep,
      { ...validStep, step_order: 2, delay_days: 3, title: 'Relance J+3' },
    ]
    const result = validateWorkflowSteps(steps)
    expect(result).toHaveLength(2)
  })

  it('rejects non-array input', () => {
    expect(() => validateWorkflowSteps('not-array')).toThrow()
  })

  it('rejects empty array', () => {
    expect(() => validateWorkflowSteps([])).toThrow()
  })

  it('rejects duplicate step_order', () => {
    const steps = [
      validStep,
      { ...validStep, title: 'Duplicate' },
    ]
    expect(() => validateWorkflowSteps(steps)).toThrow()
  })

  it('rejects negative delay_days', () => {
    const step = { ...validStep, delay_days: -1 }
    expect(() => validateWorkflowSteps([step])).toThrow()
  })

  it('rejects invalid action_type', () => {
    const step = { ...validStep, action_type: 'invalid_type' }
    expect(() => validateWorkflowSteps([step as unknown as WorkflowStep])).toThrow()
  })

  it('rejects missing title', () => {
    const step = { ...validStep, title: '' }
    expect(() => validateWorkflowSteps([step])).toThrow()
  })

  it('rejects send_email without email_subject', () => {
    const step = {
      ...validStep,
      config: { email_body_html: '<p>test</p>' },
    }
    expect(() => validateWorkflowSteps([step])).toThrow()
  })

  it('rejects send_email without email_body_html', () => {
    const step = {
      ...validStep,
      config: { email_subject: 'test' },
    }
    expect(() => validateWorkflowSteps([step])).toThrow()
  })

  it('allows non-email step without email fields', () => {
    const step: WorkflowStep = {
      step_order: 1,
      delay_days: 0,
      action_type: 'create_task',
      title: 'Create task',
      config: { title: 'Follow-up task' },
    }
    const result = validateWorkflowSteps([step])
    expect(result).toHaveLength(1)
  })
})

// ── calculateStepDueDate ─────────────────────────────────────

describe('calculateStepDueDate', () => {
  const baseDate = new Date('2026-03-01T12:00:00Z')

  it('returns same date for delay_days=0', () => {
    const result = calculateStepDueDate(0, baseDate)
    expect(result).toBe('2026-03-01T12:00:00.000Z')
  })

  it('adds 1 day for delay_days=1', () => {
    const result = calculateStepDueDate(1, baseDate)
    expect(result).toBe('2026-03-02T12:00:00.000Z')
  })

  it('adds 7 days for delay_days=7', () => {
    const result = calculateStepDueDate(7, baseDate)
    expect(result).toBe('2026-03-08T12:00:00.000Z')
  })

  it('adds 30 days for delay_days=30', () => {
    const result = calculateStepDueDate(30, baseDate)
    expect(result).toBe('2026-03-31T12:00:00.000Z')
  })

  it('adds 90 days for delay_days=90', () => {
    const result = calculateStepDueDate(90, baseDate)
    expect(result).toBe('2026-05-30T12:00:00.000Z')
  })

  it('uses current date when no fromDate provided', () => {
    const result = calculateStepDueDate(0)
    const now = new Date()
    const parsed = new Date(result)
    // Should be within 5 seconds of now
    expect(Math.abs(parsed.getTime() - now.getTime())).toBeLessThan(5000)
  })
})
