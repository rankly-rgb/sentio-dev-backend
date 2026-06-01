import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock Deno (not available in Node/Vitest) ─────────────────
vi.stubGlobal('Deno', { env: { get: vi.fn().mockReturnValue('test-key') } })

// ── Mock hubspot-client ──────────────────────────────────────
vi.mock('../functions/_shared/hubspot-client', () => ({
  getCompanyContacts: vi.fn(),
  enrollInSequence: vi.fn(),
  updateCompanyProperties: vi.fn(),
  createTask: vi.fn(),
  associateTaskToCompany: vi.fn(),
  getCompanyProperties: vi.fn(),
}))

// ── Mock dlq ─────────────────────────────────────────────────
vi.mock('../functions/_shared/dlq', () => ({
  writeToDLQ: vi.fn(),
}))

import {
  getCompanyContacts,
  enrollInSequence,
  updateCompanyProperties,
  createTask,
  associateTaskToCompany,
  getCompanyProperties,
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
  display_name: 'Acme Corp',
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

// ── hubspot_create_task ──────────────────────────────────────

describe('dispatchAction — hubspot_create_task', () => {
  const taskAction = makeAction({
    type: 'hubspot_create_task',
    config: {
      task_body: 'Score santé : {{health_score}}/100, MRR : {{mrr_euros}}€, compte : {{display_name}}',
      priority: 'HIGH',
    },
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createTask).mockResolvedValue({ success: true, status: 201, taskId: 'task-789' })
    vi.mocked(associateTaskToCompany).mockResolvedValue({ success: true, status: 201 })
    vi.mocked(getCompanyProperties).mockResolvedValue({ hubspot_owner_id: '55001' })
  })

  it('crée la tâche et l\'associe à la company avec le bon propriétaire', async () => {
    const result = await dispatchAction(taskAction, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('completed')
    expect(getCompanyProperties).toHaveBeenCalledWith('hs_company_456', ['hubspot_owner_id'], undefined)
    expect(createTask).toHaveBeenCalledOnce()
    const [subject, body, priority, , ownerId] = vi.mocked(createTask).mock.calls[0]
    // Nouveau format : "🟡 Risque modéré — Acme Corp (999€/mois)" (churn_risk=72 ≥ 70 → 🔴)
    expect(subject).toContain('Acme Corp')
    expect(subject).toContain('🔴 Churn imminent')  // churn_risk_score=72 >= 70
    expect(subject).toContain('999€/mois')           // mrr = 99900 cents = 999€
    expect(body).toContain('45/100')     // health_score
    expect(body).toContain('999')        // mrr_euros = 99900/100
    expect(body).toContain('Acme Corp')  // display_name
    expect(priority).toBe('HIGH')
    expect(ownerId).toBe('55001')
    expect(associateTaskToCompany).toHaveBeenCalledWith('task-789', 'hs_company_456', undefined)
  })

  it('retourne skipped si hubspot_company_id absent', async () => {
    const result = await dispatchAction(
      taskAction,
      { ...baseAccount, hubspot_company_id: null },
      baseContext,
      mockSupabase,
    )
    expect(result.status).toBe('skipped')
    expect(createTask).not.toHaveBeenCalled()
    expect(getCompanyProperties).not.toHaveBeenCalled()
  })

  it('ownerId absent si getCompanyProperties retourne null', async () => {
    vi.mocked(getCompanyProperties).mockResolvedValue({ hubspot_owner_id: null })
    await dispatchAction(taskAction, baseAccount, baseContext, mockSupabase)
    const [,,,,ownerId] = vi.mocked(createTask).mock.calls[0]
    expect(ownerId).toBeUndefined()
  })

  it('retourne failed et écrit en DLQ si createTask échoue', async () => {
    vi.mocked(createTask).mockResolvedValue({ success: false, status: 400, error: 'Bad Request' })

    const result = await dispatchAction(taskAction, baseAccount, baseContext, mockSupabase)
    expect(result.status).toBe('failed')
    expect(writeToDLQ).toHaveBeenCalledOnce()
    const dlqArg = vi.mocked(writeToDLQ).mock.calls[0][1]
    expect(dlqArg.event_type).toBe('task_creation_failed')
  })

  it('association échouée ne bloque pas — statut reste completed', async () => {
    vi.mocked(associateTaskToCompany).mockResolvedValue({ success: false, error: 'Association failed' })

    const result = await dispatchAction(taskAction, baseAccount, baseContext, mockSupabase)
    expect(result.status).toBe('completed')
    expect(result.message).toContain('non-blocking')
    expect(writeToDLQ).not.toHaveBeenCalled()
  })

  it('display_name null → fallback Client + 6 derniers chars stripe_customer_id', async () => {
    const accountNoName = { ...baseAccount, display_name: null }
    await dispatchAction(taskAction, accountNoName, baseContext, mockSupabase)

    const [subject] = vi.mocked(createTask).mock.calls[0]
    expect(subject).toContain('Client est123')  // slice(-6) de 'cus_test123' = 'est123'
  })

  it('churn_risk_score >= 70 → urgence 🔴', async () => {
    const acc = { ...baseAccount, churn_risk_score: 75 }
    await dispatchAction(taskAction, acc, baseContext, mockSupabase)
    const [subject] = vi.mocked(createTask).mock.calls[0]
    expect(subject).toContain('🔴 Churn imminent')
  })

  it('churn_risk_score entre 40 et 69 → urgence 🟡', async () => {
    const acc = { ...baseAccount, churn_risk_score: 55 }
    await dispatchAction(taskAction, acc, baseContext, mockSupabase)
    const [subject] = vi.mocked(createTask).mock.calls[0]
    expect(subject).toContain('🟡 Risque modéré')
  })

  it('churn_risk_score < 40 → urgence 🟢', async () => {
    const acc = { ...baseAccount, churn_risk_score: 20 }
    await dispatchAction(taskAction, acc, baseContext, mockSupabase)
    const [subject] = vi.mocked(createTask).mock.calls[0]
    expect(subject).toContain('🟢 Opportunité')
  })

  it('priorité inconnue → défaut HIGH', async () => {
    const action = makeAction({
      type: 'hubspot_create_task',
      config: { task_body: 'test', priority: 'URGENT' },
    })
    await dispatchAction(action, baseAccount, baseContext, mockSupabase)
    const [,, priority] = vi.mocked(createTask).mock.calls[0]
    expect(priority).toBe('HIGH')
  })

  it('DLQ payload ne contient pas d\'email/téléphone/IP — Zero-PII', async () => {
    vi.mocked(createTask).mockResolvedValue({ success: false, status: 500, error: 'error' })

    await dispatchAction(taskAction, baseAccount, baseContext, mockSupabase)
    const dlqArg = vi.mocked(writeToDLQ).mock.calls[0][1]
    const payload = JSON.stringify(dlqArg.payload)
    expect(payload).not.toContain('@')
    expect(payload).not.toContain('email')
    expect(payload).not.toContain('phone')
    expect(payload).not.toContain('ip')
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
