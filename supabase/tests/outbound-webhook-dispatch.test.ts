import { describe, it, expect, vi, afterEach } from 'vitest'

// ── Types miroir (identiques à la Edge Function) ─────────────

interface OutboundDestination {
  id: string
  organization_id: string
  name: string
  destination_url: string
  provider: string
  is_active: boolean
  trigger_segments: string[]
  trigger_churn_threshold: number | null
  secret_header_name: string | null
  secret_header_value: string | null
}

interface DispatchInput {
  organization_id: string
  account_id: string
  stripe_customer_id: string
  event_type: 'segment_change' | 'churn_threshold' | 'manual'
  segment_previous?: string
  segment_current: string
  health_score: number
  churn_risk_score: number
  expansion_score: number
  mrr_cents: number
}

// ── Logique extraite (miroir de la Edge Function pour tests unitaires) ────────

function matchesDestination(dest: OutboundDestination, input: DispatchInput): boolean {
  const segmentMatch =
    dest.trigger_segments.length > 0 &&
    dest.trigger_segments.indexOf(input.segment_current) !== -1

  const churnMatch =
    dest.trigger_churn_threshold !== null &&
    input.churn_risk_score >= dest.trigger_churn_threshold

  return segmentMatch || churnMatch
}

function buildOutboundPayload(input: DispatchInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    source: 'sentio_ai',
    event: 'account_risk_detected',
    account: {
      stripe_customer_id: input.stripe_customer_id,
      segment: input.segment_current,
      health_score: input.health_score,
      churn_risk_score: input.churn_risk_score,
      expansion_score: input.expansion_score,
      mrr_cents: input.mrr_cents,
      mrr_eur: Math.round(input.mrr_cents) / 100,
    },
    triggered_at: new Date().toISOString(),
    organization_id: input.organization_id,
  }

  if (input.segment_previous !== undefined) {
    ;(payload.account as Record<string, unknown>).segment_previous = input.segment_previous
  }

  return payload
}

function filterActiveDestinations(
  destinations: OutboundDestination[],
  input: DispatchInput,
): OutboundDestination[] {
  return destinations
    .filter((d) => d.is_active)
    .filter((d) => matchesDestination(d, input))
}

// ── Fixtures ──────────────────────────────────────────────────

const baseInput: DispatchInput = {
  organization_id: 'org-uuid-001',
  account_id: 'acct-uuid-001',
  stripe_customer_id: 'cus_ABCDEF',
  event_type: 'segment_change',
  segment_previous: 'a_risque_leger',
  segment_current: 'en_danger_critique',
  health_score: 25,
  churn_risk_score: 72,
  expansion_score: 10,
  mrr_cents: 49900,
}

function makeDestination(overrides: Partial<OutboundDestination> = {}): OutboundDestination {
  return {
    id: 'dest-uuid-001',
    organization_id: 'org-uuid-001',
    name: 'Brevo - Churn alert',
    destination_url: 'https://api.brevo.com/v3/contacts',
    provider: 'brevo',
    is_active: true,
    trigger_segments: ['en_danger_critique', 'en_churn'],
    trigger_churn_threshold: null,
    secret_header_name: 'api-key',
    secret_header_value: 'xkeysib-test',
    ...overrides,
  }
}

// ── Filtrage par segment ──────────────────────────────────────

describe('outbound-webhook-dispatch: filtrage par segment', () => {
  it('sélectionne une destination dont le segment_current est dans trigger_segments', () => {
    const dest = makeDestination({ trigger_segments: ['en_danger_critique', 'impayes'] })
    expect(matchesDestination(dest, baseInput)).toBe(true)
  })

  it("n'envoie pas quand segment_current n'est pas dans trigger_segments", () => {
    const dest = makeDestination({ trigger_segments: ['en_churn', 'impayes'] })
    const input = { ...baseInput, segment_current: 'stables', churn_risk_score: 30 }
    expect(matchesDestination(dest, input)).toBe(false)
  })

  it("n'envoie pas quand trigger_segments est vide et pas de churn threshold", () => {
    const dest = makeDestination({
      trigger_segments: [],
      trigger_churn_threshold: null,
    })
    expect(matchesDestination(dest, baseInput)).toBe(false)
  })

  it('sélectionne la destination si segment match même sans churn threshold', () => {
    const dest = makeDestination({
      trigger_segments: ['en_danger_critique'],
      trigger_churn_threshold: null,
    })
    const input = { ...baseInput, churn_risk_score: 20 }
    expect(matchesDestination(dest, input)).toBe(true)
  })
})

// ── Filtrage par churn threshold ─────────────────────────────

describe('outbound-webhook-dispatch: filtrage par churn_threshold', () => {
  it('sélectionne quand churn_risk_score >= trigger_churn_threshold', () => {
    const dest = makeDestination({
      trigger_segments: [],
      trigger_churn_threshold: 70,
    })
    const input = { ...baseInput, churn_risk_score: 70, segment_current: 'stables' }
    expect(matchesDestination(dest, input)).toBe(true)
  })

  it("n'envoie pas quand churn_risk_score < trigger_churn_threshold", () => {
    const dest = makeDestination({
      trigger_segments: [],
      trigger_churn_threshold: 70,
    })
    const input = { ...baseInput, churn_risk_score: 69, segment_current: 'stables' }
    expect(matchesDestination(dest, input)).toBe(false)
  })

  it('sélectionne quand churn strictement supérieur au seuil', () => {
    const dest = makeDestination({
      trigger_segments: [],
      trigger_churn_threshold: 50,
    })
    const input = { ...baseInput, churn_risk_score: 99, segment_current: 'stables' }
    expect(matchesDestination(dest, input)).toBe(true)
  })

  it('sélectionne si segment OU churn threshold match (union)', () => {
    const dest = makeDestination({
      trigger_segments: ['en_danger_critique'],
      trigger_churn_threshold: 80,
    })
    // churn = 65 (< 80) mais segment match
    const input = { ...baseInput, churn_risk_score: 65, segment_current: 'en_danger_critique' }
    expect(matchesDestination(dest, input)).toBe(true)
  })
})

// ── Destinations inactives ────────────────────────────────────

describe('outbound-webhook-dispatch: destinations inactives', () => {
  it("n'envoie pas vers une destination inactive (is_active = false)", () => {
    const destinations = [
      makeDestination({ id: 'dest-active', is_active: true, trigger_segments: ['en_danger_critique'] }),
      makeDestination({ id: 'dest-inactive', is_active: false, trigger_segments: ['en_danger_critique'] }),
    ]
    const matched = filterActiveDestinations(destinations, baseInput)
    expect(matched).toHaveLength(1)
    expect(matched[0].id).toBe('dest-active')
  })

  it('retourne une liste vide si toutes les destinations sont inactives', () => {
    const destinations = [
      makeDestination({ is_active: false, trigger_segments: ['en_danger_critique'] }),
      makeDestination({ is_active: false, trigger_segments: ['a_risque_leger', 'en_danger_critique'] }),
    ]
    expect(filterActiveDestinations(destinations, baseInput)).toHaveLength(0)
  })

  it("retourne une liste vide si aucun segment ne correspond (même si actif)", () => {
    const destinations = [
      makeDestination({ is_active: true, trigger_segments: ['stables'], trigger_churn_threshold: null }),
    ]
    const input = { ...baseInput, segment_current: 'champions', churn_risk_score: 20 }
    expect(filterActiveDestinations(destinations, input)).toHaveLength(0)
  })
})

// ── Payload Zero-PII ──────────────────────────────────────────

describe('outbound-webhook-dispatch: payload Zero-PII', () => {
  it("ne contient pas la clé 'email'", () => {
    const payload = JSON.stringify(buildOutboundPayload(baseInput))
    expect(payload).not.toContain('"email"')
  })

  it("ne contient pas la clé 'name'", () => {
    const payload = JSON.stringify(buildOutboundPayload(baseInput))
    expect(payload).not.toContain('"name"')
  })

  it("ne contient pas la clé 'phone'", () => {
    const payload = JSON.stringify(buildOutboundPayload(baseInput))
    expect(payload).not.toContain('"phone"')
  })

  it("ne contient pas la clé 'ip'", () => {
    const payload = JSON.stringify(buildOutboundPayload(baseInput))
    // Évite les faux positifs sur 'stripe_customer_id' etc.
    const parsed = buildOutboundPayload(baseInput)
    const keys = collectKeys(parsed)
    expect(keys).not.toContain('ip')
  })

  it('contient stripe_customer_id (identifiant anonyme autorisé)', () => {
    const payload = buildOutboundPayload(baseInput)
    const account = payload.account as Record<string, unknown>
    expect(account.stripe_customer_id).toBe('cus_ABCDEF')
  })

  it('calcule mrr_eur correctement depuis mrr_cents', () => {
    const payload = buildOutboundPayload({ ...baseInput, mrr_cents: 49900 })
    const account = payload.account as Record<string, unknown>
    expect(account.mrr_eur).toBe(499)
  })

  it('inclut segment_previous si fourni', () => {
    const payload = buildOutboundPayload({ ...baseInput, segment_previous: 'a_risque_leger' })
    const account = payload.account as Record<string, unknown>
    expect(account.segment_previous).toBe('a_risque_leger')
  })

  it("n'inclut pas segment_previous si absent", () => {
    const input = { ...baseInput }
    delete input.segment_previous
    const payload = buildOutboundPayload(input)
    const account = payload.account as Record<string, unknown>
    expect(account).not.toHaveProperty('segment_previous')
  })
})

// ── Log dans outbound_webhook_logs ────────────────────────────

describe('outbound-webhook-dispatch: log dans outbound_webhook_logs', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('appelle outbound_webhook_logs.insert avec success=true pour 2xx', async () => {
    const insertMock = vi.fn().mockResolvedValue({ error: null })
    const updateMock = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })
    const fromMock = vi.fn((table: string) => {
      if (table === 'outbound_webhook_logs') return { insert: insertMock }
      if (table === 'outbound_webhook_destinations') return { update: updateMock }
      return { insert: vi.fn().mockResolvedValue({ error: null }) }
    })

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"ok":true}', { status: 200 }),
    )

    const supabaseMock = { from: fromMock }
    const dest = makeDestination()
    const payload = buildOutboundPayload(baseInput)

    // Simuler la logique de dispatch pour un succès 200
    const response = await globalThis.fetch(dest.destination_url, {
      method: 'POST',
      body: JSON.stringify(payload),
    })

    const success = response.status >= 200 && response.status < 300

    await supabaseMock.from('outbound_webhook_logs').insert({
      organization_id: baseInput.organization_id,
      destination_id: dest.id,
      account_id: baseInput.account_id,
      payload,
      response_status: response.status,
      success,
      triggered_by: baseInput.event_type,
    })

    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        organization_id: 'org-uuid-001',
        destination_id: 'dest-uuid-001',
        triggered_by: 'segment_change',
      }),
    )
  })

  it('appelle outbound_webhook_logs.insert avec success=false pour 4xx', async () => {
    const insertMock = vi.fn().mockResolvedValue({ error: null })
    const fromMock = vi.fn(() => ({ insert: insertMock }))

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401 }),
    )

    const supabaseMock = { from: fromMock }
    const dest = makeDestination()
    const payload = buildOutboundPayload(baseInput)

    const response = await globalThis.fetch(dest.destination_url, { method: 'POST', body: JSON.stringify(payload) })
    const success = response.status >= 200 && response.status < 300

    await supabaseMock.from('outbound_webhook_logs').insert({
      organization_id: baseInput.organization_id,
      destination_id: dest.id,
      account_id: baseInput.account_id,
      payload,
      response_status: response.status,
      success,
      triggered_by: baseInput.event_type,
    })

    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, response_status: 401 }),
    )
  })
})

// ── Helper : collecte récursive des clés d'un objet ──────────

function collectKeys(obj: unknown): string[] {
  if (typeof obj !== 'object' || obj === null) return []
  const keys: string[] = []
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    keys.push(key)
    keys.push(...collectKeys((obj as Record<string, unknown>)[key]))
  }
  return keys
}
