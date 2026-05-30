import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock Deno (not available in Node/Vitest) ─────────────────
vi.stubGlobal('Deno', { env: { get: vi.fn().mockReturnValue('test-key') } })

// ── Mock hubspot-client ──────────────────────────────────────
vi.mock('../functions/_shared/hubspot-client', () => ({
  getCompanyContacts: vi.fn(),
  enrollInSequence: vi.fn(),
  updateCompanyProperties: vi.fn(),
}))

// ── Mock dlq ─────────────────────────────────────────────────
vi.mock('../functions/_shared/dlq', () => ({
  writeToDLQ: vi.fn(),
}))

import {
  getCompanyContacts,
  enrollInSequence,
  updateCompanyProperties,
} from '../functions/_shared/hubspot-client'
import { writeToDLQ } from '../functions/_shared/dlq'
import { dispatchAction } from '../functions/_shared/action-dispatcher'
import type { PlaybookAction, AccountData } from '../functions/_shared/playbook-engine'

// ── Helpers ──────────────────────────────────────────────────

const mockSupabase = {} as Parameters<typeof dispatchAction>[3]

const baseAccount: AccountData = {
  id: 'acc-001',
  organization_id: 'org-001',
  stripe_customer_id: 'cus_test123',
  hubspot_company_id: 'hs_company_456',
  health_score: 45,
  churn_risk_score: 72,
  expansion_score: 20,
  product_usage_score: 30,
  mrr_cents: 99900,
  arr_cents: 1198800,
  plan_tier: 'growth',
  seat_count: 5,
  seat_limit: 10,
  contract_start_date: '2025-01-01',
  contract_end_date: '2026-01-01',
  created_at: '2025-01-01T00:00:00Z',
}

const baseContext = {
  playbookId: 'pb-001',
  executionId: 'exec-001',
  organizationId: 'org-001',
}

function makeAction(overrides: Partial<PlaybookAction>): PlaybookAction {
  return {
    type: 'hubspot_enroll_sequence',
    order: 1,
    config: {},
    ...overrides,
  }
}

// ── hubspot_enroll_sequence ──────────────────────────────────

describe('dispatchAction — hubspot_enroll_sequence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCompanyContacts).mockResolvedValue(['c1', 'c2'])
    vi.mocked(enrollInSequence).mockResolvedValue({ success: true, status: 200 })
  })

  it('enrolls contacts and returns completed', async () => {
    const action = makeAction({
      type: 'hubspot_enroll_sequence',
      config: { sequence_id: 'seq-1', sender_id: 'user-1' },
    })
    const result = await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('completed')
    expect(result.message).toContain('2/2')
    expect(getCompanyContacts).toHaveBeenCalledWith('hs_company_456', undefined)
    expect(enrollInSequence).toHaveBeenCalledTimes(2)
    expect(enrollInSequence).toHaveBeenCalledWith('c1', 'seq-1', 'user-1', undefined)
    expect(enrollInSequence).toHaveBeenCalledWith('c2', 'seq-1', 'user-1', undefined)
  })

  it('returns failed when config is missing sequence_id', async () => {
    const action = makeAction({ type: 'hubspot_enroll_sequence', config: { sender_id: 'user-1' } })
    const result = await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('failed')
    expect(result.message).toContain('sequence_id')
    expect(getCompanyContacts).not.toHaveBeenCalled()
  })

  it('returns failed when config is missing sender_id', async () => {
    const action = makeAction({ type: 'hubspot_enroll_sequence', config: { sequence_id: 'seq-1' } })
    const result = await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('failed')
    expect(result.message).toContain('sender_id')
  })

  it('returns skipped when account has no hubspot_company_id', async () => {
    const action = makeAction({
      type: 'hubspot_enroll_sequence',
      config: { sequence_id: 'seq-1', sender_id: 'user-1' },
    })
    const account = { ...baseAccount, hubspot_company_id: null }
    const result = await dispatchAction(action, account, baseContext, mockSupabase)

    expect(result.status).toBe('skipped')
    expect(result.message).toContain('no hubspot_company_id')
  })

  it('returns skipped when company has no contacts in HubSpot', async () => {
    vi.mocked(getCompanyContacts).mockResolvedValue([])
    const action = makeAction({
      type: 'hubspot_enroll_sequence',
      config: { sequence_id: 'seq-1', sender_id: 'user-1' },
    })
    const result = await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('skipped')
    expect(result.message).toContain('No HubSpot contacts')
  })

  it('writes DLQ and returns failed when all enrollments fail', async () => {
    vi.mocked(enrollInSequence).mockResolvedValue({ success: false, status: 429, error: 'rate limit' })
    const action = makeAction({
      type: 'hubspot_enroll_sequence',
      config: { sequence_id: 'seq-1', sender_id: 'user-1' },
    })
    const result = await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('failed')
    expect(writeToDLQ).toHaveBeenCalledOnce()
    expect(writeToDLQ).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({
        provider: 'hubspot',
        event_type: 'sequence_enrollment_failed',
        organization_id: 'org-001',
      }),
    )
  })

  it('writes DLQ for partial failures but returns completed', async () => {
    vi.mocked(getCompanyContacts).mockResolvedValue(['c1', 'c2', 'c3'])
    vi.mocked(enrollInSequence)
      .mockResolvedValueOnce({ success: true, status: 200 })
      .mockResolvedValueOnce({ success: false, status: 500, error: 'server error' })
      .mockResolvedValueOnce({ success: true, status: 200 })

    const action = makeAction({
      type: 'hubspot_enroll_sequence',
      config: { sequence_id: 'seq-1', sender_id: 'user-1' },
    })
    const result = await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('completed')
    expect(result.message).toContain('2/3')
    expect(writeToDLQ).toHaveBeenCalledOnce()
  })

  it('limits enrollment to 5 contacts max', async () => {
    vi.mocked(getCompanyContacts).mockResolvedValue(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'])
    const action = makeAction({
      type: 'hubspot_enroll_sequence',
      config: { sequence_id: 'seq-1', sender_id: 'user-1' },
    })
    await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(enrollInSequence).toHaveBeenCalledTimes(5)
  })
})

// ── hubspot_update_company ───────────────────────────────────

describe('dispatchAction — hubspot_update_company', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(updateCompanyProperties).mockResolvedValue({ success: true, status: 200 })
  })

  it('updates company properties and returns completed', async () => {
    const action = makeAction({
      type: 'hubspot_update_company',
      config: { properties: { hs_lead_status: 'at_risk', sentio_churn_risk: '72' } },
    })
    const result = await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('completed')
    expect(updateCompanyProperties).toHaveBeenCalledWith('hs_company_456', {
      hs_lead_status: 'at_risk',
      sentio_churn_risk: '72',
    }, undefined)
  })

  it('returns failed when properties config is missing', async () => {
    const action = makeAction({ type: 'hubspot_update_company', config: {} })
    const result = await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('failed')
    expect(result.message).toContain('properties')
    expect(updateCompanyProperties).not.toHaveBeenCalled()
  })

  it('returns skipped when account has no hubspot_company_id', async () => {
    const action = makeAction({
      type: 'hubspot_update_company',
      config: { properties: { foo: 'bar' } },
    })
    const account = { ...baseAccount, hubspot_company_id: null }
    const result = await dispatchAction(action, account, baseContext, mockSupabase)

    expect(result.status).toBe('skipped')
    expect(updateCompanyProperties).not.toHaveBeenCalled()
  })

  it('writes DLQ and returns failed when API call fails', async () => {
    vi.mocked(updateCompanyProperties).mockResolvedValue({ success: false, status: 404, error: 'Not found' })
    const action = makeAction({
      type: 'hubspot_update_company',
      config: { properties: { foo: 'bar' } },
    })
    const result = await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('failed')
    expect(result.message).toContain('Not found')
    expect(writeToDLQ).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({
        provider: 'hubspot',
        event_type: 'company_update_failed',
        organization_id: 'org-001',
      }),
    )
  })
})

// ── Non-HubSpot actions (log-only) ───────────────────────────

describe('dispatchAction — log-only actions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns completed for slack_notify without external call', async () => {
    const action = makeAction({ type: 'slack_notify', config: { channel: '#cs-team' } })
    const result = await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('completed')
    expect(result.message).toContain('slack_notify')
    expect(updateCompanyProperties).not.toHaveBeenCalled()
    expect(enrollInSequence).not.toHaveBeenCalled()
  })

  it('returns completed for create_task without external call', async () => {
    const action = makeAction({ type: 'create_task', config: { title: 'Follow-up call' } })
    const result = await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('completed')
    expect(writeToDLQ).not.toHaveBeenCalled()
  })
})

// ── Zero-PII verification ────────────────────────────────────

describe('dispatchAction — Zero-PII', () => {
  it('DLQ payload for sequence enrollment never contains email, name, phone, ip', async () => {
    vi.mocked(getCompanyContacts).mockResolvedValue(['c1'])
    vi.mocked(enrollInSequence).mockResolvedValue({ success: false, status: 500, error: 'err' })

    const action = makeAction({
      type: 'hubspot_enroll_sequence',
      config: { sequence_id: 'seq-1', sender_id: 'user-1' },
    })
    const accountWithPii = {
      ...baseAccount,
      // Ces champs ne devraient jamais se retrouver dans le DLQ
    }
    await dispatchAction(action, accountWithPii, baseContext, mockSupabase)

    const dlqCall = vi.mocked(writeToDLQ).mock.calls[0]
    const payload = JSON.stringify(dlqCall[1].payload)
    expect(payload).not.toContain('@')
    expect(payload).not.toContain('email')
    expect(payload).not.toContain('phone')
    expect(payload).not.toContain('ip')
  })
})
