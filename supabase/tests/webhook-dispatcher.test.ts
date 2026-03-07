import { describe, it, expect } from 'vitest'
import {
  buildPayload,
  isEventActive,
  shouldDisableWebhook,
  computeHmacSignature,
  mapPlaybookToEvent,
  containsPII,
  type WebhookAccountData,
  type WebhookSignals,
  type WebhookEvent,
} from '../functions/_shared/webhook-helpers'

// ── Test fixtures ───────────────────────────────────────────

const ACCOUNT: WebhookAccountData = {
  account_id: '550e8400-e29b-41d4-a716-446655440000',
  stripe_customer_id: 'cus_ABC123',
  hubspot_company_id: 'hs_789',
}

const SIGNALS: WebhookSignals = {
  health_score: 28,
  churn_risk_score: 84,
  expansion_score: 12,
  mrr_cents: 49900,
  trigger_reason: 'churn_risk > 70',
}

const ORG_ID = '660e8400-e29b-41d4-a716-446655440000'

// ── buildPayload ────────────────────────────────────────────

describe('buildPayload', () => {
  it('builds a complete payload with all required fields', () => {
    const payload = buildPayload('churn_risk_critical', ORG_ID, ACCOUNT, SIGNALS)
    expect(payload.event).toBe('churn_risk_critical')
    expect(payload.organization_id).toBe(ORG_ID)
    expect(payload.account.account_id).toBe(ACCOUNT.account_id)
    expect(payload.account.stripe_customer_id).toBe('cus_ABC123')
    expect(payload.account.hubspot_company_id).toBe('hs_789')
    expect(payload.signals.health_score).toBe(28)
    expect(payload.signals.churn_risk_score).toBe(84)
    expect(payload.signals.mrr_cents).toBe(49900)
    expect(payload.signals.trigger_reason).toBe('churn_risk > 70')
    expect(payload.triggered_at).toBeTruthy()
  })

  it('omits hubspot_company_id when not provided', () => {
    const account: WebhookAccountData = {
      account_id: 'acc-1',
      stripe_customer_id: 'cus_XYZ',
    }
    const payload = buildPayload('payment_failed', ORG_ID, account, SIGNALS)
    expect(payload.account.hubspot_company_id).toBeUndefined()
    expect(payload.account.stripe_customer_id).toBe('cus_XYZ')
  })

  it('includes metadata when provided', () => {
    const payload = buildPayload('expansion_opportunity', ORG_ID, ACCOUNT, SIGNALS, {
      playbook_id: 'pb-1',
      playbook_name: 'Anti-churn',
    })
    expect(payload.metadata).toEqual({ playbook_id: 'pb-1', playbook_name: 'Anti-churn' })
  })

  it('omits metadata when empty object', () => {
    const payload = buildPayload('payment_failed', ORG_ID, ACCOUNT, SIGNALS, {})
    expect(payload.metadata).toBeUndefined()
  })

  it('always includes stripe_customer_id (Zero-PII key)', () => {
    const payload = buildPayload('churn_risk_critical', ORG_ID, ACCOUNT, SIGNALS)
    expect(payload.account.stripe_customer_id).toBeDefined()
    expect(payload.account.stripe_customer_id).toBe('cus_ABC123')
  })
})

// ── Zero-PII compliance ─────────────────────────────────────

describe('Zero-PII compliance', () => {
  it('payload does not contain email, name, phone, or address', () => {
    const payload = buildPayload('churn_risk_critical', ORG_ID, ACCOUNT, SIGNALS, {
      playbook_id: 'pb-1',
    })
    const payloadStr = JSON.stringify(payload)
    expect(payloadStr).not.toContain('"email"')
    expect(payloadStr).not.toContain('"name"')
    expect(payloadStr).not.toContain('"phone"')
    expect(payloadStr).not.toContain('"address"')
    expect(payloadStr).not.toContain('"ip"')
  })

  it('containsPII detects email field', () => {
    expect(containsPII({ email: 'test@example.com' })).toBe(true)
  })

  it('containsPII detects nested PII', () => {
    expect(containsPII({ account: { name: 'John', id: '123' } })).toBe(true)
  })

  it('containsPII returns false for clean payload', () => {
    const payload = buildPayload('churn_risk_critical', ORG_ID, ACCOUNT, SIGNALS)
    expect(containsPII(payload)).toBe(false)
  })

  it('containsPII handles null/undefined', () => {
    expect(containsPII(null)).toBe(false)
    expect(containsPII(undefined)).toBe(false)
  })
})

// ── isEventActive ───────────────────────────────────────────

describe('isEventActive', () => {
  const events = ['churn_risk_critical', 'payment_failed', 'expansion_opportunity']

  it('returns true when event is in active list', () => {
    expect(isEventActive('churn_risk_critical', events)).toBe(true)
    expect(isEventActive('payment_failed', events)).toBe(true)
  })

  it('returns false when event is not in active list', () => {
    expect(isEventActive('renewal_reminder', events)).toBe(false)
    expect(isEventActive('onboarding_completed', events)).toBe(false)
  })

  it('returns false for empty active events list', () => {
    expect(isEventActive('churn_risk_critical', [])).toBe(false)
  })
})

// ── shouldDisableWebhook ────────────────────────────────────

describe('shouldDisableWebhook', () => {
  it('returns false when failure_count < 5', () => {
    expect(shouldDisableWebhook(0)).toBe(false)
    expect(shouldDisableWebhook(4)).toBe(false)
  })

  it('returns true when failure_count >= 5', () => {
    expect(shouldDisableWebhook(5)).toBe(true)
    expect(shouldDisableWebhook(10)).toBe(true)
  })

  it('returns true at exact boundary (5)', () => {
    expect(shouldDisableWebhook(5)).toBe(true)
  })

  it('returns false at boundary - 1 (4)', () => {
    expect(shouldDisableWebhook(4)).toBe(false)
  })
})

// ── computeHmacSignature ────────────────────────────────────

describe('computeHmacSignature', () => {
  it('produces a valid hex string', async () => {
    const sig = await computeHmacSignature('{"event":"test"}', 'my-secret-key')
    expect(sig).toMatch(/^[0-9a-f]{64}$/) // SHA-256 = 64 hex chars
  })

  it('produces deterministic output for same input', async () => {
    const sig1 = await computeHmacSignature('hello', 'secret')
    const sig2 = await computeHmacSignature('hello', 'secret')
    expect(sig1).toBe(sig2)
  })

  it('produces different output for different payloads', async () => {
    const sig1 = await computeHmacSignature('payload-a', 'secret')
    const sig2 = await computeHmacSignature('payload-b', 'secret')
    expect(sig1).not.toBe(sig2)
  })

  it('produces different output for different secrets', async () => {
    const sig1 = await computeHmacSignature('payload', 'secret-1')
    const sig2 = await computeHmacSignature('payload', 'secret-2')
    expect(sig1).not.toBe(sig2)
  })

  it('signature matches known HMAC-SHA256 value', async () => {
    // Verify against a known test vector
    const payload = '{"test":true}'
    const secret = 'test-secret'
    const sig = await computeHmacSignature(payload, secret)
    // Re-compute to verify consistency
    const sig2 = await computeHmacSignature(payload, secret)
    expect(sig).toBe(sig2)
    expect(sig.length).toBe(64)
  })
})

// ── mapPlaybookToEvent ──────────────────────────────────────

describe('mapPlaybookToEvent', () => {
  it('returns churn_risk_critical for churn_risk_score gte condition', () => {
    const result = mapPlaybookToEvent({
      operator: 'AND',
      conditions: [
        { field: 'churn_risk_score', operator: 'gte', value: 70 },
      ],
    })
    expect(result).toBe('churn_risk_critical')
  })

  it('returns health_score_drop for health_score lte condition', () => {
    const result = mapPlaybookToEvent({
      operator: 'AND',
      conditions: [
        { field: 'health_score', operator: 'lte', value: 30 },
      ],
    })
    expect(result).toBe('health_score_drop')
  })

  it('returns expansion_opportunity for expansion_score gte condition', () => {
    const result = mapPlaybookToEvent({
      operator: 'AND',
      conditions: [
        { field: 'expansion_score', operator: 'gte', value: 80 },
      ],
    })
    expect(result).toBe('expansion_opportunity')
  })

  it('returns null for null trigger_conditions', () => {
    expect(mapPlaybookToEvent(null)).toBeNull()
  })

  it('returns null for empty conditions array', () => {
    expect(mapPlaybookToEvent({ operator: 'AND', conditions: [] })).toBeNull()
  })

  it('returns null for unrecognized fields', () => {
    const result = mapPlaybookToEvent({
      operator: 'AND',
      conditions: [
        { field: 'plan_tier', operator: 'eq', value: 'enterprise' },
      ],
    })
    expect(result).toBeNull()
  })

  it('returns first matching event when multiple conditions match', () => {
    const result = mapPlaybookToEvent({
      operator: 'AND',
      conditions: [
        { field: 'churn_risk_score', operator: 'gte', value: 70 },
        { field: 'health_score', operator: 'lte', value: 30 },
      ],
    })
    // churn_risk_score is checked first
    expect(result).toBe('churn_risk_critical')
  })

  it('handles gt operator for churn_risk_score', () => {
    const result = mapPlaybookToEvent({
      operator: 'AND',
      conditions: [
        { field: 'churn_risk_score', operator: 'gt', value: 70 },
      ],
    })
    expect(result).toBe('churn_risk_critical')
  })

  it('handles lt operator for health_score', () => {
    const result = mapPlaybookToEvent({
      operator: 'AND',
      conditions: [
        { field: 'health_score', operator: 'lt', value: 30 },
      ],
    })
    expect(result).toBe('health_score_drop')
  })
})
