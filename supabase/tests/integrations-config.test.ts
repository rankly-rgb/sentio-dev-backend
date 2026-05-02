import { describe, it, expect } from 'vitest'

// ── Fonctions pures miroir (integrations-config/index.ts) ────

const VALID_PROVIDERS = ['stripe', 'hubspot'] as const
type Provider = typeof VALID_PROVIDERS[number]

function validateApiKey(provider: Provider, apiKey: unknown): string | null {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    return 'api_key ne peut pas être vide'
  }
  if (provider === 'stripe') {
    if (!apiKey.startsWith('sk_live_') && !apiKey.startsWith('sk_test_')) {
      return 'La clé Stripe doit commencer par sk_live_ ou sk_test_'
    }
  }
  return null
}

function validatePostBody(body: unknown): { valid: boolean; error?: string; provider?: Provider; api_key?: string } {
  if (typeof body !== 'object' || body === null) return { valid: false, error: 'Invalid JSON body' }
  const b = body as Record<string, unknown>
  if (!b.provider || !VALID_PROVIDERS.includes(b.provider as Provider)) {
    return { valid: false, error: `provider doit être l'un de : ${VALID_PROVIDERS.join(', ')}` }
  }
  const err = validateApiKey(b.provider as Provider, b.api_key)
  if (err) return { valid: false, error: err }
  return { valid: true, provider: b.provider as Provider, api_key: (b.api_key as string).trim() }
}

// ── Résolution de la clé Stripe (sync-stripe) ────────────────

function resolveStripeKey(orgStripeKey: string | null | undefined, envKey: string | undefined): string | null {
  return orgStripeKey ?? envKey ?? null
}

// ── Tests validateApiKey ──────────────────────────────────────

describe('validateApiKey', () => {
  it('accepte sk_live_ pour stripe', () => {
    expect(validateApiKey('stripe', 'sk_live_abc123')).toBeNull()
  })

  it('accepte sk_test_ pour stripe', () => {
    expect(validateApiKey('stripe', 'sk_test_abc123')).toBeNull()
  })

  it('rejette une clé stripe sans préfixe valide', () => {
    expect(validateApiKey('stripe', 'pk_live_abc123')).not.toBeNull()
  })

  it('rejette une clé stripe vide', () => {
    expect(validateApiKey('stripe', '')).not.toBeNull()
  })

  it('rejette une clé stripe composée uniquement d\'espaces', () => {
    expect(validateApiKey('stripe', '   ')).not.toBeNull()
  })

  it('accepte n\'importe quelle chaîne non vide pour hubspot', () => {
    expect(validateApiKey('hubspot', 'pat-eu1-abc123')).toBeNull()
  })

  it('rejette une clé hubspot vide', () => {
    expect(validateApiKey('hubspot', '')).not.toBeNull()
  })

  it('rejette api_key non-string', () => {
    expect(validateApiKey('stripe', null as unknown as string)).not.toBeNull()
  })
})

// ── Tests validatePostBody ────────────────────────────────────

describe('validatePostBody', () => {
  it('accepte un body stripe valide', () => {
    const result = validatePostBody({ provider: 'stripe', api_key: 'sk_test_abc' })
    expect(result.valid).toBe(true)
    expect(result.provider).toBe('stripe')
    expect(result.api_key).toBe('sk_test_abc')
  })

  it('accepte un body hubspot valide', () => {
    const result = validatePostBody({ provider: 'hubspot', api_key: 'pat-eu1-abc' })
    expect(result.valid).toBe(true)
    expect(result.provider).toBe('hubspot')
  })

  it('trim la clé avant de la retourner', () => {
    const result = validatePostBody({ provider: 'hubspot', api_key: '  pat-eu1-abc  ' })
    expect(result.api_key).toBe('pat-eu1-abc')
  })

  it('rejette un provider inconnu', () => {
    const result = validatePostBody({ provider: 'salesforce', api_key: 'abc' })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('provider')
  })

  it('rejette un body null', () => {
    expect(validatePostBody(null).valid).toBe(false)
  })

  it('rejette une clé stripe avec mauvais préfixe', () => {
    const result = validatePostBody({ provider: 'stripe', api_key: 'rk_live_abc' })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('sk_live_')
  })

  it('rejette api_key absent', () => {
    const result = validatePostBody({ provider: 'stripe' })
    expect(result.valid).toBe(false)
  })
})

// ── Tests resolveStripeKey (sync-stripe) ─────────────────────

describe('resolveStripeKey', () => {
  it('utilise la clé org en priorité', () => {
    expect(resolveStripeKey('sk_test_org', 'sk_live_env')).toBe('sk_test_org')
  })

  it('fallback sur env si pas de clé org', () => {
    expect(resolveStripeKey(null, 'sk_live_env')).toBe('sk_live_env')
  })

  it('fallback sur env si clé org undefined', () => {
    expect(resolveStripeKey(undefined, 'sk_live_env')).toBe('sk_live_env')
  })

  it('retourne null si aucune clé disponible', () => {
    expect(resolveStripeKey(null, undefined)).toBeNull()
  })
})
