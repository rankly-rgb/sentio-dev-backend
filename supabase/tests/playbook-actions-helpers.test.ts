import { describe, it, expect } from 'vitest'
import {
  buildSlackNotifyMessage,
  buildFlagEntry,
  mergeFlag,
  hasFlag,
  buildNoteEntry,
  type AccountContext,
  type FlagEntry,
} from '../functions/_shared/playbook-actions-helpers'

// ── buildSlackNotifyMessage ──────────────────────────────────

describe('buildSlackNotifyMessage', () => {
  const account: AccountContext = {
    id: 'acc-123',
    stripe_customer_id: 'cus_abc',
    health_score: 45,
    churn_risk_score: 72,
    expansion_score: 30,
    mrr_cents: 49900,
  }

  it('builds default message with scores and MRR', () => {
    const msg = buildSlackNotifyMessage({}, account, 'Prévention churn')
    expect(msg).toContain('Prévention churn')
    expect(msg).toContain('cus_abc')
    expect(msg).toContain('45')
    expect(msg).toContain('72')
    expect(msg).toContain('499')
  })

  it('includes channel in default message if provided', () => {
    const msg = buildSlackNotifyMessage({ channel: 'cs-team' }, account, 'Test')
    expect(msg).toContain('#cs-team')
  })

  it('uses custom message template with variable substitution', () => {
    const msg = buildSlackNotifyMessage(
      { message: 'Alert: {stripe_customer_id} churn={churn_risk}% MRR={mrr_eur}€ playbook={playbook}' },
      account,
      'Mon Playbook',
    )
    expect(msg).toBe('Alert: cus_abc churn=72% MRR=499€ playbook=Mon Playbook')
  })

  it('handles null scores gracefully', () => {
    const nullAccount: AccountContext = { id: 'acc-x', mrr_cents: null, health_score: null, churn_risk_score: null }
    const msg = buildSlackNotifyMessage({}, nullAccount, 'Test')
    expect(msg).toContain('?')
    expect(msg).not.toContain('null')
  })

  it('uses account.id when stripe_customer_id is missing', () => {
    const msg = buildSlackNotifyMessage({}, { id: 'acc-456' }, 'Test')
    expect(msg).toContain('acc-456')
  })

  it('never contains email or PII', () => {
    const msg = buildSlackNotifyMessage(
      { message: '{stripe_customer_id}' },
      account,
      'Test',
    )
    expect(msg).not.toMatch(/@/)
    expect(msg).not.toMatch(/email/i)
  })
})

// ── buildFlagEntry ───────────────────────────────────────────

describe('buildFlagEntry', () => {
  const now = new Date('2026-03-12T10:00:00Z')

  it('builds flag with defaults', () => {
    const flag = buildFlagEntry({}, 'pb-1', now)
    expect(flag.flag).toBe('review_needed')
    expect(flag.set_at).toBe('2026-03-12T10:00:00.000Z')
    expect(flag.playbook_id).toBe('pb-1')
    expect(flag.reason).toBe('Signalé par playbook')
  })

  it('uses custom flag name and reason', () => {
    const flag = buildFlagEntry({ flag: 'escalation', reason: 'Churn > 80%' }, 'pb-2', now)
    expect(flag.flag).toBe('escalation')
    expect(flag.reason).toBe('Churn > 80%')
  })

  it('handles null playbook_id', () => {
    const flag = buildFlagEntry({}, null, now)
    expect(flag.playbook_id).toBeNull()
  })
})

// ── mergeFlag ────────────────────────────────────────────────

describe('mergeFlag', () => {
  const existingFlag: FlagEntry = {
    flag: 'review_needed',
    set_at: '2026-03-10T00:00:00Z',
    playbook_id: 'old-pb',
    reason: 'Old reason',
  }

  it('adds new flag to empty array', () => {
    const newFlag = buildFlagEntry({ flag: 'escalation' }, 'pb-1', new Date())
    const result = mergeFlag([], newFlag)
    expect(result).toHaveLength(1)
    expect(result[0].flag).toBe('escalation')
  })

  it('replaces existing flag with same name (dedup)', () => {
    const newFlag = buildFlagEntry({ flag: 'review_needed', reason: 'Updated' }, 'pb-2', new Date())
    const result = mergeFlag([existingFlag], newFlag)
    expect(result).toHaveLength(1)
    expect(result[0].reason).toBe('Updated')
    expect(result[0].playbook_id).toBe('pb-2')
  })

  it('preserves other flags when adding', () => {
    const otherFlag: FlagEntry = { flag: 'vip', set_at: '2026-01-01T00:00:00Z', playbook_id: null, reason: 'VIP' }
    const newFlag = buildFlagEntry({ flag: 'escalation' }, 'pb-1', new Date())
    const result = mergeFlag([existingFlag, otherFlag], newFlag)
    expect(result).toHaveLength(3)
  })

  it('handles null/undefined existingFlags', () => {
    const newFlag = buildFlagEntry({}, 'pb-1', new Date())
    const result = mergeFlag(null as unknown as FlagEntry[], newFlag)
    expect(result).toHaveLength(1)
  })
})

// ── hasFlag ──────────────────────────────────────────────────

describe('hasFlag', () => {
  const flags: FlagEntry[] = [
    { flag: 'review_needed', set_at: '2026-03-12T00:00:00Z', playbook_id: null, reason: '' },
  ]

  it('returns true when flag exists', () => {
    expect(hasFlag(flags, 'review_needed')).toBe(true)
  })

  it('returns false when flag does not exist', () => {
    expect(hasFlag(flags, 'escalation')).toBe(false)
  })

  it('handles empty array', () => {
    expect(hasFlag([], 'review_needed')).toBe(false)
  })

  it('handles null array', () => {
    expect(hasFlag(null as unknown as FlagEntry[], 'review_needed')).toBe(false)
  })
})

// ── buildNoteEntry ───────────────────────────────────────────

describe('buildNoteEntry', () => {
  const account: AccountContext = {
    id: 'acc-1',
    stripe_customer_id: 'cus_xyz',
    health_score: 35,
    churn_risk_score: 78,
    mrr_cents: 29900,
  }

  it('builds note with default title and body', () => {
    const note = buildNoteEntry({}, account, 'org-1', 'pb-1', 'exec-1', 'Prévention churn')
    expect(note.account_id).toBe('acc-1')
    expect(note.organization_id).toBe('org-1')
    expect(note.note_type).toBe('playbook_action')
    expect(note.source).toBe('playbook')
    expect(note.playbook_id).toBe('pb-1')
    expect(note.execution_id).toBe('exec-1')
    expect(note.title).toContain('Prévention churn')
    expect(note.body).toContain('35')
    expect(note.body).toContain('78')
    expect(note.body).toContain('299')
  })

  it('uses custom title and body from config', () => {
    const note = buildNoteEntry(
      { title: 'Custom title', body: 'Custom body' },
      account, 'org-1', 'pb-1', 'exec-1', 'Test',
    )
    expect(note.title).toBe('Custom title')
    expect(note.body).toBe('Custom body')
  })

  it('handles null scores in default body', () => {
    const nullAccount: AccountContext = { id: 'acc-2', health_score: null, churn_risk_score: null, mrr_cents: null }
    const note = buildNoteEntry({}, nullAccount, 'org-1', null, null, 'Test')
    expect(note.body).toContain('?')
    expect(note.playbook_id).toBeNull()
    expect(note.execution_id).toBeNull()
  })

  it('never contains PII in default body', () => {
    const note = buildNoteEntry({}, account, 'org-1', 'pb-1', 'exec-1', 'Test')
    expect(note.body).not.toMatch(/@/)
    expect(note.body).not.toMatch(/email/i)
    expect(note.body).not.toMatch(/phone/i)
  })
})
