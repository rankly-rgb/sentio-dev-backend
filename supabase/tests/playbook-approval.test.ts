import { describe, it, expect } from 'vitest'
import {
  canApprove,
  canReject,
  isPlaybookMatch,
  buildPendingApprovalLog,
  buildApprovalLog,
  buildApprovalSlackMessage,
} from '../functions/_shared/playbook-approval-helpers'

// ── canApprove ──────────────────────────────────────────────

describe('canApprove', () => {
  it('returns true for pending_approval', () => {
    expect(canApprove({ execution_status: 'pending_approval' })).toBe(true)
  })

  it('returns false for running', () => {
    expect(canApprove({ execution_status: 'running' })).toBe(false)
  })

  it('returns false for completed', () => {
    expect(canApprove({ execution_status: 'completed' })).toBe(false)
  })

  it('returns false for failed', () => {
    expect(canApprove({ execution_status: 'failed' })).toBe(false)
  })

  it('returns false for cancelled', () => {
    expect(canApprove({ execution_status: 'cancelled' })).toBe(false)
  })

  it('returns false for pending (not pending_approval)', () => {
    expect(canApprove({ execution_status: 'pending' })).toBe(false)
  })
})

// ── canReject ───────────────────────────────────────────────

describe('canReject', () => {
  it('returns true for pending_approval', () => {
    expect(canReject({ execution_status: 'pending_approval' })).toBe(true)
  })

  it('returns false for running', () => {
    expect(canReject({ execution_status: 'running' })).toBe(false)
  })

  it('returns false for completed', () => {
    expect(canReject({ execution_status: 'completed' })).toBe(false)
  })

  it('returns false for failed', () => {
    expect(canReject({ execution_status: 'failed' })).toBe(false)
  })

  it('returns false for cancelled', () => {
    expect(canReject({ execution_status: 'cancelled' })).toBe(false)
  })
})

// ── isPlaybookMatch ─────────────────────────────────────────

describe('isPlaybookMatch', () => {
  it('returns true when execution playbook_id matches the URL playbook_id', () => {
    expect(isPlaybookMatch({ playbook_id: 'pb-001' }, 'pb-001')).toBe(true)
  })

  it('returns false when execution playbook_id does not match the URL playbook_id', () => {
    expect(isPlaybookMatch({ playbook_id: 'pb-001' }, 'pb-999')).toBe(false)
  })
})

// ── buildPendingApprovalLog ─────────────────────────────────

describe('buildPendingApprovalLog', () => {
  it('stores account IDs and planned actions', () => {
    const accountIds = ['acc-001', 'acc-002']
    const actions = [
      { type: 'slack_notify', config: { channel: '#cs' }, order: 1 },
    ]

    const log = buildPendingApprovalLog(accountIds, actions)

    expect(log.status).toBe('pending_approval')
    expect(log.account_ids).toEqual(['acc-001', 'acc-002'])
    expect(log.planned_actions).toEqual(actions)
    expect(log.accounts_count).toBe(2)
    expect(log.created_at).toBeDefined()
  })

  it('stores trigger_reasons when provided', () => {
    const reasons = { 'acc-001': 'churn_risk >= 70' }
    const log = buildPendingApprovalLog(['acc-001'], [], reasons)

    expect(log.trigger_reasons).toEqual(reasons)
  })

  it('defaults trigger_reasons to empty object', () => {
    const log = buildPendingApprovalLog([], [])

    expect(log.trigger_reasons).toEqual({})
  })

  it('stores only UUIDs, no PII', () => {
    const log = buildPendingApprovalLog(['uuid-1', 'uuid-2'], [])

    // Zero-PII: only UUIDs in account_ids, no email/name/phone
    const logStr = JSON.stringify(log)
    expect(logStr).not.toContain('@')
    expect(logStr).not.toContain('email')
    expect(logStr).not.toContain('phone')
  })
})

// ── buildApprovalLog ────────────────────────────────────────

describe('buildApprovalLog', () => {
  it('includes rejection reason', () => {
    const existingLog = { account_ids: ['acc-001'], status: 'pending_approval' }
    const result = buildApprovalLog(existingLog, 'Not relevant anymore')

    expect(result.rejection_reason).toBe('Not relevant anymore')
    expect(result.status).toBe('cancelled')
    expect(result.rejected_at).toBeDefined()
  })

  it('preserves existing log fields', () => {
    const existingLog = {
      account_ids: ['acc-001', 'acc-002'],
      planned_actions: [{ type: 'slack_notify' }],
      accounts_count: 2,
    }
    const result = buildApprovalLog(existingLog, 'Rejected')

    expect(result.account_ids).toEqual(['acc-001', 'acc-002'])
    expect(result.planned_actions).toEqual([{ type: 'slack_notify' }])
    expect(result.accounts_count).toBe(2)
    expect(result.rejection_reason).toBe('Rejected')
  })

  it('handles null reason', () => {
    const result = buildApprovalLog({})
    expect(result.rejection_reason).toBeNull()
  })

  it('handles null execution_log', () => {
    const result = buildApprovalLog(null, 'reason')
    expect(result.rejection_reason).toBe('reason')
    expect(result.status).toBe('cancelled')
  })

  it('handles non-object execution_log', () => {
    const result = buildApprovalLog('invalid', 'reason')
    expect(result.rejection_reason).toBe('reason')
    expect(result.status).toBe('cancelled')
  })
})

// ── buildApprovalSlackMessage ───────────────────────────────

describe('buildApprovalSlackMessage', () => {
  it('includes playbook title and account count', () => {
    const msg = buildApprovalSlackMessage(
      'Prevention churn',
      12,
      ['slack_notify', 'create_task'],
      'https://app.sentio.ai',
      'pb-001',
      'exec-001',
    )

    expect(msg).toContain('Prevention churn')
    expect(msg).toContain('12 compte(s)')
    expect(msg).toContain('slack_notify, create_task')
  })

  it('includes link with FRONTEND_URL', () => {
    const msg = buildApprovalSlackMessage(
      'Test',
      5,
      ['slack_notify'],
      'https://app.sentio.ai',
      'pb-001',
      'exec-001',
    )

    expect(msg).toContain('https://app.sentio.ai/dashboard/playbooks/pb-001/executions/exec-001')
  })

  it('omits link when FRONTEND_URL is empty', () => {
    const msg = buildApprovalSlackMessage(
      'Test',
      5,
      ['slack_notify'],
      '',
      'pb-001',
      'exec-001',
    )

    expect(msg).not.toContain('http')
  })

  it('handles empty action types', () => {
    const msg = buildApprovalSlackMessage(
      'Test',
      3,
      [],
      '',
      'pb-001',
      'exec-001',
    )

    expect(msg).toContain('aucune action')
  })

  it('starts with [APPROVAL] prefix', () => {
    const msg = buildApprovalSlackMessage('Test', 1, [], '', 'pb', 'ex')
    expect(msg.startsWith('[APPROVAL]')).toBe(true)
  })
})
