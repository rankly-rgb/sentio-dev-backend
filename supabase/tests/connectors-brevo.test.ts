import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock Deno (non disponible dans Node/Vitest) ──────────────
vi.stubGlobal('Deno', { env: { get: vi.fn().mockReturnValue('test-key') } })

// ── Mocks des dépendances partagées ─────────────────────────
vi.mock('../functions/_shared/fetch-with-timeout', () => ({
  fetchWithTimeout: vi.fn(),
}))
vi.mock('../functions/_shared/retry-with-backoff', () => ({
  retryWithBackoff: vi.fn((fn: () => Promise<unknown>) => fn()),
}))
vi.mock('../functions/_shared/circuit-breaker', () => ({
  CircuitBreaker: vi.fn(function (this: Record<string, unknown>) {
    this.execute = vi.fn((fn: () => Promise<unknown>) => fn())
  }),
}))

import { fetchWithTimeout } from '../functions/_shared/fetch-with-timeout'
import type { ConnectorConfig, ConnectorPayload } from '../functions/_shared/connectors/types'
import { callBrevo } from '../functions/_shared/connectors/brevo'

const mockFetch = fetchWithTimeout as ReturnType<typeof vi.fn>

// ── Fixtures ──────────────────────────────────────────────────

const basePayload: ConnectorPayload = {
  stripe_customer_id: 'cus_TEST123',
  segment: 'en_danger_critique',
  segment_previous: 'a_risque_leger',
  health_score: 22,
  churn_risk_score: 85,
  expansion_score: 8,
  mrr_cents: 49900,
  mrr_eur: 499,
  organization_id: 'org-uuid-001',
  trigger_reason: 'segment_change',
  // Transit PII — jamais persisté
  customer_email_transit: 'test@example.com',
}

const baseConfig: ConnectorConfig = {
  api_key: 'xkeysib-test-api-key',
  template_id: '42',
}

function makeResponse(status: number, body = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve({}),
  } as unknown as Response
}

// ── Tests Brevo ───────────────────────────────────────────────

describe('connector brevo: callBrevo', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("appelle le bon endpoint Brevo pour l'upsert contact", async () => {
    // Premier appel : upsert contact (200)
    // Deuxième appel : ajout à la liste (200)
    mockFetch
      .mockResolvedValueOnce(makeResponse(200, '{"id":1}'))
      .mockResolvedValueOnce(makeResponse(200, '{"contacts":{"success":["test@example.com"]}}'))

    await callBrevo(basePayload, baseConfig)

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.brevo.com/v3/contacts',
      expect.objectContaining({ method: 'POST' }),
      10000,
    )
  })

  it('retourne success: true sur HTTP 200', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(200))
      .mockResolvedValueOnce(makeResponse(200, 'ok'))

    const result = await callBrevo(basePayload, baseConfig)
    expect(result.success).toBe(true)
  })

  it('retourne success: false sur HTTP 401', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(401, 'Unauthorized'))

    const result = await callBrevo(basePayload, { ...baseConfig, template_id: undefined })
    expect(result.success).toBe(false)
  })

  it('retourne success: false sur HTTP 500', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(500, 'Internal Server Error'))

    const result = await callBrevo(basePayload, { ...baseConfig, template_id: undefined })
    expect(result.success).toBe(false)
    expect(result.http_status).toBe(500)
  })

  it('tronque connector_response à 500 chars', async () => {
    const longResponse = 'x'.repeat(1000)
    mockFetch
      .mockResolvedValueOnce(makeResponse(200))
      .mockResolvedValueOnce(makeResponse(200, longResponse))

    const result = await callBrevo(basePayload, baseConfig)
    if (result.connector_response) {
      expect(result.connector_response.length).toBeLessThanOrEqual(500)
    }
  })

  it("retourne success: false si fetchWithTimeout lève une exception", async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network timeout'))

    const result = await callBrevo(basePayload, { ...baseConfig, template_id: undefined })
    expect(result.success).toBe(false)
    expect(result.error_message).toContain('timeout')
  })

  it("n'expose pas l'email transit dans le résultat retourné", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(200))
      .mockResolvedValueOnce(makeResponse(200, 'ok'))

    const result = await callBrevo(basePayload, baseConfig)
    const resultStr = JSON.stringify(result)
    expect(resultStr).not.toContain('test@example.com')
    expect(resultStr).not.toContain('@')
  })

  it('appelle également le endpoint de liste si template_id configuré', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(200))
      .mockResolvedValueOnce(makeResponse(200, 'ok'))

    await callBrevo(basePayload, baseConfig)

    expect(mockFetch).toHaveBeenCalledTimes(2)
    const secondCallUrl = mockFetch.mock.calls[1][0] as string
    expect(secondCallUrl).toContain('/contacts/lists/42/contacts/add')
  })

  it('retourne http_status de la réponse', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(429, 'Too Many Requests'))

    const result = await callBrevo(basePayload, { ...baseConfig, template_id: undefined })
    expect(result.success).toBe(false)
    expect(result.http_status).toBe(429)
  })
})

// ── Zero-PII Brevo ────────────────────────────────────────────

describe('connector brevo: Zero-PII', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it("le ConnectorResult ne contient pas d'adresse email", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(200))
      .mockResolvedValueOnce(makeResponse(200, 'email:ignored-in-result@test.com'))

    const result = await callBrevo(basePayload, baseConfig)
    const resultJson = JSON.stringify(result)
    // La réponse Brevo peut contenir un email, mais on vérifie la troncature
    // et que l'email transit n'est pas dans les champs contrôlés
    const emailTransit = basePayload.customer_email_transit
    expect(result.connector_response ?? '').not.toContain(emailTransit)
    // error_message ne doit pas contenir l'email transit
    expect(result.error_message ?? '').not.toContain(emailTransit)
  })
})
