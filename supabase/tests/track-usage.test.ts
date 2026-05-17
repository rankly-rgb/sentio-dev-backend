import { describe, it, expect } from 'vitest'

// ── Fonctions pures extraites de track-usage/index.ts ────────

const VALID_EVENT_TYPES = ['login', 'feature_used', 'api_call', 'export', 'report_viewed'] as const
const VALID_SOURCES = ['api', 'webhook', 'manual'] as const

type EventType = typeof VALID_EVENT_TYPES[number]
type SourceType = typeof VALID_SOURCES[number]

function isValidEventType(v: unknown): v is EventType {
  return typeof v === 'string' && (VALID_EVENT_TYPES as readonly string[]).includes(v)
}

function isValidSource(v: unknown): v is SourceType {
  return typeof v === 'string' && (VALID_SOURCES as readonly string[]).includes(v)
}

function isValidDate(v: unknown): boolean {
  if (typeof v !== 'string') return false
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v))
}

// Simule la logique de vérification du header secret
function validateWebhookSecretHeader(headers: Record<string, string | undefined>): string | null {
  const secret = headers['X-Sentio-Webhook-Secret']
  if (!secret || secret.trim() === '') return null
  return secret
}

// ── Tests : isValidEventType ──────────────────────────────────

describe('isValidEventType', () => {
  it('accepts all valid types', () => {
    for (const t of VALID_EVENT_TYPES) {
      expect(isValidEventType(t)).toBe(true)
    }
  })

  it('rejects unknown event type', () => {
    expect(isValidEventType('page_view')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidEventType('')).toBe(false)
  })

  it('rejects non-string', () => {
    expect(isValidEventType(42)).toBe(false)
    expect(isValidEventType(null)).toBe(false)
    expect(isValidEventType(undefined)).toBe(false)
  })

  it('is case-sensitive', () => {
    expect(isValidEventType('LOGIN')).toBe(false)
    expect(isValidEventType('Login')).toBe(false)
  })
})

// ── Tests : isValidSource ─────────────────────────────────────

describe('isValidSource', () => {
  it('accepts all valid sources', () => {
    for (const s of VALID_SOURCES) {
      expect(isValidSource(s)).toBe(true)
    }
  })

  it('rejects unknown source', () => {
    expect(isValidSource('sdk')).toBe(false)
    expect(isValidSource('cron')).toBe(false)
  })

  it('rejects non-string', () => {
    expect(isValidSource(null)).toBe(false)
    expect(isValidSource(undefined)).toBe(false)
  })
})

// ── Tests : isValidDate ───────────────────────────────────────

describe('isValidDate', () => {
  it('accepts valid ISO date', () => {
    expect(isValidDate('2026-05-17')).toBe(true)
    expect(isValidDate('2024-01-01')).toBe(true)
  })

  it('rejects datetime with time component', () => {
    expect(isValidDate('2026-05-17T10:00:00Z')).toBe(false)
  })

  it('rejects invalid date like 2026-13-01', () => {
    expect(isValidDate('2026-13-01')).toBe(false)
  })

  it('rejects free text', () => {
    expect(isValidDate('today')).toBe(false)
    expect(isValidDate('')).toBe(false)
  })

  it('rejects non-string', () => {
    expect(isValidDate(20260517)).toBe(false)
    expect(isValidDate(null)).toBe(false)
  })

  it('rejects wrong format (DD/MM/YYYY)', () => {
    expect(isValidDate('17/05/2026')).toBe(false)
  })
})

// ── Tests : validateWebhookSecretHeader ───────────────────────

describe('validateWebhookSecretHeader (auth X-Sentio-Webhook-Secret)', () => {
  it('returns secret when header is present', () => {
    const result = validateWebhookSecretHeader({ 'X-Sentio-Webhook-Secret': 'abc123' })
    expect(result).toBe('abc123')
  })

  it('returns null when header is absent', () => {
    const result = validateWebhookSecretHeader({})
    expect(result).toBeNull()
  })

  it('returns null when header is empty string', () => {
    const result = validateWebhookSecretHeader({ 'X-Sentio-Webhook-Secret': '' })
    expect(result).toBeNull()
  })

  it('returns null when header is only whitespace', () => {
    const result = validateWebhookSecretHeader({ 'X-Sentio-Webhook-Secret': '   ' })
    expect(result).toBeNull()
  })

  it('accepts long secret (UUID format)', () => {
    const secret = '550e8400-e29b-41d4-a716-446655440000'
    const result = validateWebhookSecretHeader({ 'X-Sentio-Webhook-Secret': secret })
    expect(result).toBe(secret)
  })

  it('does not accept Authorization header as substitute', () => {
    const result = validateWebhookSecretHeader({ 'Authorization': 'Bearer abc123' })
    expect(result).toBeNull()
  })
})
