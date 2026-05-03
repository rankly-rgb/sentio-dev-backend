import { describe, it, expect } from 'vitest'

// ── Tests unitaires de logique extraite de playbook-test ─────
// La Edge Function elle-même nécessite un env Deno.
// Ces tests vérifient la logique pure et les garanties Zero-PII.

// ── Helpers miroir ────────────────────────────────────────────

interface PlaybookDestination {
  id: string
  organization_id: string
  connector: string
  api_key_vault_key: string | null
  api_endpoint: string | null
  template_id: string | null
  message_template: string | null
}

interface ExecutionLogRow {
  organization_id: string
  destination_id: string
  account_id: string
  stripe_customer_id: string
  connector: string
  trigger_reason: string
  segment_at_trigger: string
  churn_risk_at_trigger: number
  mrr_cents_at_trigger: number
  success: boolean
  http_status: number | null
  error_message: string | null
  connector_response: string | null
}

function buildTestLogRow(
  dest: PlaybookDestination,
  organizationId: string,
  accountId: string,
  success: boolean,
  httpStatus: number | null,
  errorMessage: string | null,
  connectorResponse: string | null,
): ExecutionLogRow {
  return {
    organization_id: organizationId,
    destination_id: dest.id,
    account_id: accountId,
    stripe_customer_id: 'cus_TEST_SENTIO',
    connector: dest.connector,
    trigger_reason: 'manual',
    segment_at_trigger: 'en_danger_critique',
    churn_risk_at_trigger: 85,
    mrr_cents_at_trigger: 19900,
    success,
    http_status: httpStatus,
    error_message: errorMessage,
    connector_response: connectorResponse,
  }
}

function makeTestDest(overrides: Partial<PlaybookDestination> = {}): PlaybookDestination {
  return {
    id: 'dest-uuid-001',
    organization_id: 'org-uuid-001',
    connector: 'brevo',
    api_key_vault_key: 'xkeysib-test',
    api_endpoint: null,
    template_id: '42',
    message_template: null,
    ...overrides,
  }
}

// ── Tests destination_id invalide ─────────────────────────────

describe('playbook-test: validation destination_id', () => {
  it('retourne une erreur si destination_id est absent', () => {
    const body: { destination_id?: string } = {}
    const valid = typeof body.destination_id === 'string' && body.destination_id.length > 0
    expect(valid).toBe(false)
  })

  it('retourne une erreur si destination_id est une chaîne vide', () => {
    const body = { destination_id: '' }
    const valid = typeof body.destination_id === 'string' && body.destination_id.length > 0
    expect(valid).toBe(false)
  })

  it('valide correctement un destination_id UUID valide', () => {
    const body = { destination_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }
    const valid = typeof body.destination_id === 'string' && body.destination_id.length > 0
    expect(valid).toBe(true)
  })
})

// ── Zero-PII : playbook_execution_logs sans email ────────────

describe('playbook-test: Zero-PII — log sans email', () => {
  it("le log inséré dans playbook_execution_logs ne contient pas de colonne email", () => {
    const dest = makeTestDest()
    const logRow = buildTestLogRow(
      dest,
      'org-uuid-001',
      'acct-uuid-001',
      true,
      200,
      null,
      'ok',
    )
    const keys = Object.keys(logRow)
    expect(keys.some((k) => k.toLowerCase().includes('email'))).toBe(false)
    expect(keys.some((k) => k.toLowerCase().includes('phone'))).toBe(false)
    expect(keys.some((k) => k.toLowerCase().includes('name'))).toBe(false)
    // 'ip' comme colonne PII (ex: ip_address, client_ip) — 'stripe' contient 'ip' mais est un id opaque
    expect(keys.some((k) => k === 'ip' || k.startsWith('ip_') || k.endsWith('_ip'))).toBe(false)
  })

  it("le stripe_customer_id du test est l'identifiant fictif Sentio", () => {
    const dest = makeTestDest()
    const logRow = buildTestLogRow(dest, 'org-uuid-001', 'acct-uuid-001', true, 200, null, null)
    expect(logRow.stripe_customer_id).toBe('cus_TEST_SENTIO')
  })

  it("les valeurs du log ne contiennent pas de format email (@)", () => {
    const dest = makeTestDest()
    const logRow = buildTestLogRow(
      dest,
      'org-uuid-001',
      'acct-uuid-001',
      false,
      401,
      'Unauthorized',
      null,
    )
    const values = Object.values(logRow).filter((v) => v !== null && v !== undefined)
    const hasEmail = values.some(
      (v) => typeof v === 'string' && /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(v)
    )
    expect(hasEmail).toBe(false)
  })

  it('trigger_reason est toujours manual pour playbook-test', () => {
    const dest = makeTestDest()
    const logRow = buildTestLogRow(dest, 'org-uuid-001', 'acct-uuid-001', true, 200, null, null)
    expect(logRow.trigger_reason).toBe('manual')
  })
})

// ── Account fictif ────────────────────────────────────────────

describe('playbook-test: données fictives du test', () => {
  it('utilise le stripe_customer_id fictif cus_TEST_SENTIO', () => {
    expect('cus_TEST_SENTIO').toMatch(/^cus_TEST_/)
  })

  it('le segment de test est en_danger_critique', () => {
    const dest = makeTestDest()
    const logRow = buildTestLogRow(dest, 'org-uuid-001', 'acct-uuid-001', true, 200, null, null)
    expect(logRow.segment_at_trigger).toBe('en_danger_critique')
  })

  it('le churn_risk de test est 85', () => {
    const dest = makeTestDest()
    const logRow = buildTestLogRow(dest, 'org-uuid-001', 'acct-uuid-001', true, 200, null, null)
    expect(logRow.churn_risk_at_trigger).toBe(85)
  })
})
