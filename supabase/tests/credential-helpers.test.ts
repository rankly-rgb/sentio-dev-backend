import { describe, it, expect } from 'vitest'
import {
  resolveCredentialSource,
  validateStripeApiKey,
  type IntegrationRow,
  type OAuthIntegrationRow,
} from '../functions/_shared/credential-helpers'

// ── Fixtures ────────────────────────────────────────────────

const VAULT_SECRET_ID = '550e8400-e29b-41d4-a716-446655440000'
const PROVIDER_ACCOUNT_ID = 'acct_123abc'
const VALID_TOKEN = 'sk_live_xxxx'

function makeIntegration(overrides: Partial<IntegrationRow> = {}): IntegrationRow {
  return {
    vault_access_token_id: VAULT_SECRET_ID,
    provider_account_id: PROVIDER_ACCOUNT_ID,
    status: 'active',
    token_expires_at: null,
    ...overrides,
  }
}

// ── 1. Integration OAuth active + Vault OK → utilise OAuth ──

describe('resolveCredentialSource — OAuth happy path', () => {
  it('returns oauth source when integration and vault secret both exist (Stripe)', () => {
    const result = resolveCredentialSource(makeIntegration(), VALID_TOKEN, 'stripe')
    expect(result).toEqual({
      type: 'oauth',
      vaultSecretId: VAULT_SECRET_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
    })
  })

  it('returns oauth source when integration and vault secret both exist (HubSpot)', () => {
    const integration = makeIntegration({
      token_expires_at: new Date(Date.now() + 3600_000).toISOString(), // 1h from now
    })
    const result = resolveCredentialSource(integration, VALID_TOKEN, 'hubspot')
    expect(result.type).toBe('oauth')
  })

  it('returns provider_account_id as null when not set', () => {
    const integration = makeIntegration({ provider_account_id: null })
    const result = resolveCredentialSource(integration, VALID_TOKEN, 'stripe')
    expect(result.type).toBe('oauth')
    if (result.type === 'oauth') {
      expect(result.providerAccountId).toBeNull()
    }
  })
})

// ── 2. Pas d'integration → fallback global ───────────

describe('resolveCredentialSource — global fallback', () => {
  it('returns global_fallback when no integration exists', () => {
    const result = resolveCredentialSource(null, null, 'stripe')
    expect(result).toEqual({ type: 'global_fallback' })
  })

  it('returns global_fallback for HubSpot when no integration exists', () => {
    const result = resolveCredentialSource(null, null, 'hubspot')
    expect(result).toEqual({ type: 'global_fallback' })
  })
})

// ── 3. Integration active + vault_access_token_id manquant → throw ──

describe('resolveCredentialSource — missing vault_access_token_id', () => {
  it('throws when Stripe integration has no vault_access_token_id', () => {
    const integration = makeIntegration({ vault_access_token_id: null })
    expect(() => resolveCredentialSource(integration, null, 'stripe'))
      .toThrow('vault_access_token_id is missing')
  })

  it('throws when HubSpot integration has no vault_access_token_id', () => {
    const integration = makeIntegration({ vault_access_token_id: null })
    expect(() => resolveCredentialSource(integration, null, 'hubspot'))
      .toThrow('vault_access_token_id is missing')
  })

  it('error message includes provider name and fix instruction', () => {
    const integration = makeIntegration({ vault_access_token_id: null })
    expect(() => resolveCredentialSource(integration, null, 'stripe'))
      .toThrow('Revoke and reconnect stripe')
  })

  it('error message includes integration method', () => {
    const integration = makeIntegration({ vault_access_token_id: null, integration_method: 'api_key' })
    expect(() => resolveCredentialSource(integration, null, 'stripe'))
      .toThrow('(api_key)')
  })
})

// ── 4. Integration active + Vault retourne null → throw (pas de fallback) ──

describe('resolveCredentialSource — vault secret missing (stale ID)', () => {
  it('throws when Vault returns null for active Stripe integration', () => {
    expect(() => resolveCredentialSource(makeIntegration(), null, 'stripe'))
      .toThrow('token not found in Vault')
  })

  it('throws when Vault returns null for active HubSpot integration', () => {
    const integration = makeIntegration({
      token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    })
    expect(() => resolveCredentialSource(integration, null, 'hubspot'))
      .toThrow('token not found in Vault')
  })

  it('error message includes vault secret ID for debugging', () => {
    expect(() => resolveCredentialSource(makeIntegration(), null, 'stripe'))
      .toThrow(VAULT_SECRET_ID)
  })

  it('does NOT fallback to global key when integration exists but Vault fails', () => {
    // Critical: previously the code would silently fall through to the global
    // STRIPE_SECRET_KEY, syncing the WRONG account.
    expect(() => resolveCredentialSource(makeIntegration(), null, 'stripe'))
      .toThrow() // Must throw, not return global_fallback
  })
})

// ── 5. HubSpot token expiration ─────────────────────────────

describe('resolveCredentialSource — HubSpot token expiration', () => {
  it('throws when HubSpot token is expired', () => {
    const integration = makeIntegration({
      token_expires_at: new Date(Date.now() - 1000).toISOString(), // expired 1s ago
    })
    expect(() => resolveCredentialSource(integration, VALID_TOKEN, 'hubspot'))
      .toThrow('token expired')
  })

  it('does not check expiration for Stripe (long-lived tokens)', () => {
    const integration = makeIntegration({
      token_expires_at: new Date(Date.now() - 1000).toISOString(), // would be expired
    })
    const result = resolveCredentialSource(integration, VALID_TOKEN, 'stripe')
    expect(result.type).toBe('oauth') // No throw
  })

  it('allows HubSpot token that is not yet expired', () => {
    const integration = makeIntegration({
      token_expires_at: new Date(Date.now() + 60_000).toISOString(), // 1 min from now
    })
    const result = resolveCredentialSource(integration, VALID_TOKEN, 'hubspot')
    expect(result.type).toBe('oauth')
  })

  it('allows HubSpot token with null token_expires_at', () => {
    const integration = makeIntegration({ token_expires_at: null })
    const result = resolveCredentialSource(integration, VALID_TOKEN, 'hubspot')
    expect(result.type).toBe('oauth')
  })
})

// ── 6. API Key integration ──────────────────────────────────

describe('resolveCredentialSource — API key integration', () => {
  it('returns api_key source when integration_method is api_key', () => {
    const integration = makeIntegration({
      integration_method: 'api_key',
      provider_account_id: 'acct_direct_123',
    })
    const result = resolveCredentialSource(integration, VALID_TOKEN, 'stripe')
    expect(result).toEqual({
      type: 'api_key',
      vaultSecretId: VAULT_SECRET_ID,
      providerAccountId: 'acct_direct_123',
    })
  })

  it('returns api_key with null providerAccountId', () => {
    const integration = makeIntegration({
      integration_method: 'api_key',
      provider_account_id: null,
    })
    const result = resolveCredentialSource(integration, VALID_TOKEN, 'stripe')
    expect(result.type).toBe('api_key')
    if (result.type === 'api_key') {
      expect(result.providerAccountId).toBeNull()
    }
  })

  it('defaults to oauth when integration_method is null', () => {
    const integration = makeIntegration({ integration_method: null })
    const result = resolveCredentialSource(integration, VALID_TOKEN, 'stripe')
    expect(result.type).toBe('oauth')
  })

  it('defaults to oauth when integration_method is undefined', () => {
    const integration = makeIntegration()
    delete (integration as Record<string, unknown>).integration_method
    const result = resolveCredentialSource(integration, VALID_TOKEN, 'stripe')
    expect(result.type).toBe('oauth')
  })

  it('throws when api_key integration has no vault secret', () => {
    const integration = makeIntegration({ integration_method: 'api_key' })
    expect(() => resolveCredentialSource(integration, null, 'stripe'))
      .toThrow('token not found in Vault')
  })

  it('does not check HubSpot expiration for api_key method', () => {
    const integration = makeIntegration({
      integration_method: 'api_key',
      token_expires_at: new Date(Date.now() - 1000).toISOString(), // expired
    })
    // api_key method should not check expiration even for hubspot
    const result = resolveCredentialSource(integration, VALID_TOKEN, 'hubspot')
    expect(result.type).toBe('api_key')
  })
})

// ── 7. validateStripeApiKey ─────────────────────────────────

describe('validateStripeApiKey', () => {
  it('accepts sk_live_ key with sufficient length', () => {
    const result = validateStripeApiKey('sk_live_51T65tbGaqS0J01nLAIWLMDMKx2l2iI8gH0OfrMezXlFs2wbxhO9o')
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('accepts sk_test_ key', () => {
    const result = validateStripeApiKey('sk_test_51T65tbGaqS0J01nLAIWLMDMKx2l2iI8gH0OfrMezXlFs2wbxhO9o')
    expect(result.valid).toBe(true)
  })

  it('accepts rk_live_ restricted key', () => {
    const result = validateStripeApiKey('rk_live_51T65tbGaqS0J01nLAIWLMDMKx2l2iI8gH0O')
    expect(result.valid).toBe(true)
  })

  it('accepts rk_test_ restricted key', () => {
    const result = validateStripeApiKey('rk_test_51T65tbGaqS0J01nLAIWLMDMKx2l2iI8gH0O')
    expect(result.valid).toBe(true)
  })

  it('rejects publishable key (pk_)', () => {
    const result = validateStripeApiKey('pk_live_51T65tbGaqS0J01nLAIWLMDMKx2l2iI8gH0OfrMezXlFs2wbxhO9o')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('pk_')
  })

  it('rejects unknown prefix', () => {
    const result = validateStripeApiKey('xx_live_51T65tbGaqS0J01nLAIWLMDMKx2l2iI8gH0OfrMezXlFs2wbxhO9o')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Format invalide')
  })

  it('rejects key shorter than 30 chars', () => {
    const result = validateStripeApiKey('sk_live_short')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('trop courte')
  })

  it('rejects empty string', () => {
    const result = validateStripeApiKey('')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('requise')
  })

  it('trims whitespace before validation', () => {
    const key = '  sk_live_51T65tbGaqS0J01nLAIWLMDMKx2l2iI8gH0OfrMezXlFs2wbxhO9o  '
    const result = validateStripeApiKey(key)
    expect(result.valid).toBe(true)
  })

  it('boundary: exactly 30 chars sk_live_ is valid', () => {
    // sk_live_ = 8 chars, need 22 more = 30 total
    const key = 'sk_live_' + 'a'.repeat(22)
    expect(key.length).toBe(30)
    const result = validateStripeApiKey(key)
    expect(result.valid).toBe(true)
  })

  it('boundary: 29 chars sk_live_ is too short', () => {
    const key = 'sk_live_' + 'a'.repeat(21)
    expect(key.length).toBe(29)
    const result = validateStripeApiKey(key)
    expect(result.valid).toBe(false)
  })
})
