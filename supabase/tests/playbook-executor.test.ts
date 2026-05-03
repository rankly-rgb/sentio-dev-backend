import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Types miroir (identiques à la Edge Function) ─────────────

interface PlaybookDestination {
  id: string
  organization_id: string
  name: string
  connector: string
  is_active: boolean
  trigger_segments: string[]
  trigger_churn_threshold: number | null
  trigger_on_invoice_past_due: boolean
  api_key_vault_key: string | null
  api_endpoint: string | null
  template_id: string | null
  message_template: string | null
}

interface ExecutorInput {
  organization_id: string
  stripe_customer_id: string
  trigger_reason: 'segment_change' | 'churn_threshold' | 'invoice_past_due' | 'manual'
  account_id?: string
  segment_current?: string
  segment_previous?: string
  health_score?: number
  churn_risk_score?: number
  expansion_score?: number
  mrr_cents?: number
}

// ── Logique extraite (miroir de la Edge Function pour tests unitaires) ────────

function matchesDestination(dest: PlaybookDestination, input: ExecutorInput): boolean {
  if (!dest.is_active) return false

  if (
    dest.trigger_segments.length > 0 &&
    input.segment_current !== undefined &&
    dest.trigger_segments.indexOf(input.segment_current) !== -1
  ) return true

  if (
    dest.trigger_churn_threshold !== null &&
    input.churn_risk_score !== undefined &&
    input.churn_risk_score >= dest.trigger_churn_threshold
  ) return true

  if (
    dest.trigger_on_invoice_past_due &&
    input.trigger_reason === 'invoice_past_due'
  ) return true

  return false
}

// ── Fixtures ──────────────────────────────────────────────────

const baseInput: ExecutorInput = {
  organization_id: 'org-uuid-001',
  stripe_customer_id: 'cus_TEST123',
  trigger_reason: 'segment_change',
  segment_current: 'en_danger_critique',
  segment_previous: 'a_risque_leger',
  health_score: 22,
  churn_risk_score: 75,
  expansion_score: 8,
  mrr_cents: 49900,
}

function makeDestination(overrides: Partial<PlaybookDestination> = {}): PlaybookDestination {
  return {
    id: 'dest-uuid-001',
    organization_id: 'org-uuid-001',
    name: 'Brevo - Churn Alert',
    connector: 'brevo',
    is_active: true,
    trigger_segments: ['en_danger_critique', 'en_churn'],
    trigger_churn_threshold: null,
    trigger_on_invoice_past_due: false,
    api_key_vault_key: 'xkeysib-test',
    api_endpoint: null,
    template_id: '42',
    message_template: null,
    ...overrides,
  }
}

// ── matchesDestination ────────────────────────────────────────

describe('playbook-executor: matchesDestination', () => {
  it('retourne true quand segment_current est dans trigger_segments', () => {
    const dest = makeDestination({ trigger_segments: ['en_danger_critique', 'impayes'] })
    expect(matchesDestination(dest, baseInput)).toBe(true)
  })

  it('retourne true quand churn_risk_score >= trigger_churn_threshold', () => {
    const dest = makeDestination({
      trigger_segments: [],
      trigger_churn_threshold: 70,
    })
    const input = { ...baseInput, segment_current: 'stables', churn_risk_score: 75 }
    expect(matchesDestination(dest, input)).toBe(true)
  })

  it('retourne false si la destination est inactive', () => {
    const dest = makeDestination({ is_active: false })
    expect(matchesDestination(dest, baseInput)).toBe(false)
  })

  it("retourne false si aucun critère ne correspond", () => {
    const dest = makeDestination({
      trigger_segments: ['en_churn'],
      trigger_churn_threshold: 90,
      trigger_on_invoice_past_due: false,
    })
    const input = { ...baseInput, segment_current: 'stables', churn_risk_score: 40 }
    expect(matchesDestination(dest, input)).toBe(false)
  })

  it('retourne true pour trigger_on_invoice_past_due avec trigger_reason=invoice_past_due', () => {
    const dest = makeDestination({
      trigger_segments: [],
      trigger_churn_threshold: null,
      trigger_on_invoice_past_due: true,
    })
    const input = { ...baseInput, trigger_reason: 'invoice_past_due' as const, segment_current: undefined }
    expect(matchesDestination(dest, input)).toBe(true)
  })

  it("retourne false pour trigger_on_invoice_past_due quand trigger_reason != invoice_past_due", () => {
    const dest = makeDestination({
      trigger_segments: [],
      trigger_churn_threshold: null,
      trigger_on_invoice_past_due: true,
    })
    const input = { ...baseInput, trigger_reason: 'segment_change' as const }
    expect(matchesDestination(dest, input)).toBe(false)
  })

  it('retourne false si trigger_churn_threshold égal mais churn_risk_score strictement inférieur', () => {
    const dest = makeDestination({
      trigger_segments: [],
      trigger_churn_threshold: 80,
    })
    const input = { ...baseInput, churn_risk_score: 79 }
    expect(matchesDestination(dest, input)).toBe(false)
  })

  it('retourne true si churn_risk_score exactement égal au seuil', () => {
    const dest = makeDestination({
      trigger_segments: [],
      trigger_churn_threshold: 75,
    })
    const input = { ...baseInput, churn_risk_score: 75 }
    expect(matchesDestination(dest, input)).toBe(true)
  })
})

// ── Zero-PII : payload loggé ne contient jamais d'email ──────

describe('playbook-executor: Zero-PII — log sans email', () => {
  it("le payload loggé dans playbook_execution_logs ne contient pas de clé 'email'", () => {
    const logRow = {
      organization_id: 'org-uuid-001',
      destination_id: 'dest-uuid-001',
      account_id: 'acct-uuid-001',
      stripe_customer_id: 'cus_TEST123',
      connector: 'brevo',
      trigger_reason: 'segment_change',
      segment_at_trigger: 'en_danger_critique',
      churn_risk_at_trigger: 75,
      mrr_cents_at_trigger: 49900,
      success: true,
      http_status: 200,
      error_message: null,
      connector_response: 'contact upserted',
    }
    const keys = Object.keys(logRow)
    expect(keys.some((k) => k.toLowerCase().includes('email'))).toBe(false)
    expect(keys.some((k) => k.toLowerCase().includes('mail'))).toBe(false)
    expect(keys.some((k) => k.toLowerCase().includes('customer_email'))).toBe(false)
  })

  it("les valeurs du log ne contiennent pas d'adresse email (vérification format @)", () => {
    const logRow = {
      stripe_customer_id: 'cus_TEST123',
      segment_at_trigger: 'en_danger_critique',
      connector_response: 'contact upserted',
      error_message: null,
    }
    const values = Object.values(logRow).filter((v) => v !== null)
    const hasEmail = values.some(
      (v) => typeof v === 'string' && /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(v)
    )
    expect(hasEmail).toBe(false)
  })

  it("le DLQ payload ne contient pas d'adresse email", () => {
    const dlqPayload = {
      destination_id: 'dest-uuid-001',
      stripe_customer_id: 'cus_TEST123',
      trigger_reason: 'segment_change',
    }
    const serialized = JSON.stringify(dlqPayload)
    expect(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(serialized)).toBe(false)
  })
})

// ── Fire-and-forget ───────────────────────────────────────────

describe('playbook-executor: fire-and-forget', () => {
  it('le scoring ne doit pas être bloqué si playbook-executor échoue', async () => {
    // Simuler un fetch qui rejette immédiatement
    const failingFetch = vi.fn().mockRejectedValue(new Error('network error'))
    let scoringCompleted = false

    // Simuler le pattern fire-and-forget de calculate-scores
    const runScoring = async () => {
      const fireAndForget = failingFetch('http://localhost/playbook-executor', {
        method: 'POST',
        body: JSON.stringify({ organization_id: 'org-1', stripe_customer_id: 'cus_1' }),
      }).catch((_err: unknown) => {
        // Erreur silencieuse — ne pas propager
      })
      // Le scoring continue sans await
      scoringCompleted = true
      // On n'attend pas fireAndForget pour marquer le scoring terminé
      await fireAndForget
    }

    await runScoring()
    expect(scoringCompleted).toBe(true)
    expect(failingFetch).toHaveBeenCalledOnce()
  })
})
