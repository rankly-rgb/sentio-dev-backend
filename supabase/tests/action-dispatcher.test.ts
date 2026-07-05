import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock Deno env ─────────────────────────────────────────────
const mockDenoEnvGet = vi.fn((key: string) => key === 'RESEND_API_KEY' ? 'resend-test-key' : undefined)
vi.stubGlobal('Deno', { env: { get: mockDenoEnvGet } })

// ── Mock fetch (Resend API) ───────────────────────────────────
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// ── Mock dlq ─────────────────────────────────────────────────
vi.mock('../functions/_shared/dlq', () => ({
  writeToDLQ: vi.fn(),
}))

import { writeToDLQ } from '../functions/_shared/dlq'
import { dispatchAction } from '../functions/_shared/action-dispatcher'
import type { PlaybookAction, AccountData } from '../functions/_shared/playbook-engine'

// ── Helpers ──────────────────────────────────────────────────

const mockSupabase = {} as Parameters<typeof dispatchAction>[3]

const baseAccount: AccountData = {
  id: 'acc-001',
  organization_id: 'org-001',
  stripe_customer_id: 'cus_test123',
  hubspot_company_id: null,
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
  organization_notification_email: 'alerts@customer.io',
}

function makeAction(overrides: Partial<PlaybookAction>): PlaybookAction {
  return {
    type: 'log_note',
    order: 1,
    config: {},
    ...overrides,
  }
}

// ── send_email ───────────────────────────────────────────────

describe('dispatchAction — send_email', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDenoEnvGet.mockImplementation((key: string) => key === 'RESEND_API_KEY' ? 'resend-test-key' : undefined)
    mockFetch.mockResolvedValue({ ok: true, status: 200 })
  })

  it('sends email and returns completed', async () => {
    const action = makeAction({
      type: 'send_email',
      config: {
        email_subject: 'Alerte churn — Acme Corp',
        email_body_html: '<p>Compte à risque critique.</p>',
      },
    })
    const result = await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('completed')
    expect(result.message).toContain('alerts@customer.io')
    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    const body = JSON.parse(opts.body)
    expect(body.to).toEqual(['alerts@customer.io'])
    expect(body.subject).toBe('Alerte churn — Acme Corp')
    expect(body.from).toContain('sentioapp.io')
  })

  it('returns failed when RESEND_API_KEY is not configured', async () => {
    mockDenoEnvGet.mockReturnValue(undefined)
    const action = makeAction({
      type: 'send_email',
      config: { email_subject: 'Test', email_body_html: '<p>body</p>' },
    })
    const result = await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('failed')
    expect(result.message).toContain('RESEND_API_KEY')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns failed when organization has no notification_email', async () => {
    const contextNoEmail = { ...baseContext, organization_notification_email: undefined }
    const action = makeAction({
      type: 'send_email',
      config: { email_subject: 'Test', email_body_html: '<p>body</p>' },
    })
    const result = await dispatchAction(action, baseAccount, contextNoEmail, mockSupabase)

    expect(result.status).toBe('failed')
    expect(result.message).toContain('notification_email')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns failed when email_subject or email_body_html is missing', async () => {
    const action = makeAction({
      type: 'send_email',
      config: { email_subject: 'Only subject, no body' },
    })
    const result = await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('failed')
    expect(result.message).toContain('email_subject')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns failed and truncates error when Resend returns non-2xx', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => 'Unprocessable Entity — invalid from domain',
    })
    const action = makeAction({
      type: 'send_email',
      config: { email_subject: 'Alert', email_body_html: '<p>body content</p>' },
    })
    const result = await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('failed')
    expect(result.message).toContain('422')
  })

  it("Zero-PII : le payload Resend ne contient pas le stripe_customer_id ni d'identifiant personnel", async () => {
    const action = makeAction({
      type: 'send_email',
      config: { email_subject: 'Alert', email_body_html: '<p>body content</p>' },
    })
    await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    const [, opts] = mockFetch.mock.calls[0]
    const body = JSON.parse(opts.body)
    expect(JSON.stringify(body)).not.toContain('phone')
    expect(JSON.stringify(body)).not.toContain('cus_test123')
    expect(body.to).toEqual(['alerts@customer.io'])
  })
})

// ── export_csv ───────────────────────────────────────────────

describe('dispatchAction — export_csv', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns completed without external call', async () => {
    const action = makeAction({ type: 'export_csv', config: {} })
    const result = await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('completed')
    expect(mockFetch).not.toHaveBeenCalled()
    expect(writeToDLQ).not.toHaveBeenCalled()
  })

  it('includes accounts_targeted count from context in message', async () => {
    const action = makeAction({ type: 'export_csv', config: {} })
    const ctx = { ...baseContext, accounts_targeted: 12 }
    const result = await dispatchAction(action, baseAccount, ctx, mockSupabase)

    expect(result.message).toContain('12')
  })

  it('returns 0 accounts when accounts_targeted not set', async () => {
    const action = makeAction({ type: 'export_csv', config: {} })
    const ctx = { ...baseContext, accounts_targeted: undefined }
    const result = await dispatchAction(action, baseAccount, ctx, mockSupabase)

    expect(result.status).toBe('completed')
    expect(result.message).toContain('0')
  })
})

// ── log-only actions ─────────────────────────────────────────

describe('dispatchAction — log-only actions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns completed for log_note without external call', async () => {
    const action = makeAction({ type: 'log_note', config: { note: 'Manual check needed' } })
    const result = await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('completed')
    expect(result.message).toContain('log_note')
    expect(mockFetch).not.toHaveBeenCalled()
    expect(writeToDLQ).not.toHaveBeenCalled()
  })

  it('returns completed for flag_for_review without external call', async () => {
    const action = makeAction({ type: 'flag_for_review', config: {} })
    const result = await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('completed')
    expect(writeToDLQ).not.toHaveBeenCalled()
  })
})

// ── DLQ on catch ─────────────────────────────────────────────

describe('dispatchAction — DLQ on unexpected error', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDenoEnvGet.mockImplementation((key: string) => key === 'RESEND_API_KEY' ? 'resend-test-key' : undefined)
  })

  it('writes DLQ with provider outbound when fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('Network timeout'))
    const action = makeAction({
      type: 'send_email',
      config: { email_subject: 'Alert', email_body_html: '<p>body content</p>' },
    })
    const result = await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    expect(result.status).toBe('failed')
    expect(writeToDLQ).toHaveBeenCalledOnce()
    expect(writeToDLQ).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({
        provider: 'outbound',
        event_type: 'action_dispatch_error',
        organization_id: 'org-001',
      }),
    )
  })

  it("DLQ payload ne contient aucune adresse email ni PII — Zero-PII", async () => {
    mockFetch.mockRejectedValue(new Error('Network timeout'))
    const action = makeAction({
      type: 'send_email',
      config: { email_subject: 'Alert', email_body_html: '<p>body content</p>' },
    })
    await dispatchAction(action, baseAccount, baseContext, mockSupabase)

    const dlqArg = vi.mocked(writeToDLQ).mock.calls[0][1]
    const payload = JSON.stringify(dlqArg.payload)
    // Vérifie l'absence d'adresses email (pattern @domain) et de PII personnelles
    expect(payload).not.toMatch(/@[a-z]/)     // pas d'adresse email réelle
    expect(payload).not.toContain('phone')
    expect(payload).not.toContain('ip_address')
    expect(payload).not.toContain('full_name')
  })
})
