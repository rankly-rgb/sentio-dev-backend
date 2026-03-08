import { describe, it, expect } from 'vitest'
import {
  isValidProvider,
  isStateExpired,
  isValidRedirectUrl,
  buildStripeAuthorizeUrl,
  buildHubSpotAuthorizeUrl,
  parseCallbackParams,
  isTokenExpiringSoon,
  buildIntegrationSummary,
  STRIPE_SCOPES,
  HUBSPOT_SCOPES,
} from '../functions/_shared/oauth-helpers'

// ── isValidProvider ───────────────────────────────────────────

describe('isValidProvider', () => {
  it('accepts stripe', () => {
    expect(isValidProvider('stripe')).toBe(true)
  })

  it('accepts hubspot', () => {
    expect(isValidProvider('hubspot')).toBe(true)
  })

  it('rejects unknown providers', () => {
    expect(isValidProvider('salesforce')).toBe(false)
    expect(isValidProvider('')).toBe(false)
    expect(isValidProvider('Stripe')).toBe(false)
  })
})

// ── isStateExpired ────────────────────────────────────────────

describe('isStateExpired', () => {
  it('returns false for future expiry', () => {
    const future = new Date(Date.now() + 600_000).toISOString()
    expect(isStateExpired(future)).toBe(false)
  })

  it('returns true for past expiry', () => {
    const past = new Date(Date.now() - 1000).toISOString()
    expect(isStateExpired(past)).toBe(true)
  })

  it('returns true for current timestamp (boundary)', () => {
    const now = new Date(Date.now() - 1).toISOString()
    expect(isStateExpired(now)).toBe(true)
  })
})

// ── isValidRedirectUrl ────────────────────────────────────────

describe('isValidRedirectUrl', () => {
  it('returns true for null (optional field)', () => {
    expect(isValidRedirectUrl(null)).toBe(true)
  })

  it('returns true for undefined', () => {
    expect(isValidRedirectUrl(undefined)).toBe(true)
  })

  it('returns true for valid HTTPS URL', () => {
    expect(isValidRedirectUrl('https://app.sentio.ai/settings')).toBe(true)
  })

  it('returns false for HTTP URL', () => {
    expect(isValidRedirectUrl('http://app.sentio.ai/settings')).toBe(false)
  })

  it('returns false for invalid URL', () => {
    expect(isValidRedirectUrl('not-a-url')).toBe(false)
  })
})

// ── buildStripeAuthorizeUrl ───────────────────────────────────

describe('buildStripeAuthorizeUrl', () => {
  it('builds correct Stripe Connect OAuth URL', () => {
    const url = buildStripeAuthorizeUrl('ca_test123', 'https://example.com/callback', 'state-abc')
    expect(url).toContain('https://connect.stripe.com/oauth/authorize')
    expect(url).toContain('client_id=ca_test123')
    expect(url).toContain('scope=read_write')
    expect(url).toContain('state=state-abc')
    expect(url).toContain('redirect_uri=')
    expect(url).toContain('response_type=code')
  })

  it('uses read_write scope (required by Stripe Connect Standard)', () => {
    const url = buildStripeAuthorizeUrl('ca_x', 'https://cb.co', 'st')
    expect(url).toContain('scope=read_write')
  })
})

// ── buildHubSpotAuthorizeUrl ──────────────────────────────────

describe('buildHubSpotAuthorizeUrl', () => {
  it('builds correct HubSpot OAuth URL', () => {
    const url = buildHubSpotAuthorizeUrl('hs_client', 'https://example.com/callback', 'state-xyz')
    expect(url).toContain('https://app-eu1.hubspot.com/oauth/authorize')
    expect(url).toContain('client_id=hs_client')
    expect(url).toContain('state=state-xyz')
    expect(url).toContain('redirect_uri=')
  })

  it('includes companies.read and deals.read scopes', () => {
    const url = buildHubSpotAuthorizeUrl('c', 'https://cb.co', 's')
    expect(url).toContain('crm.objects.companies.read')
    expect(url).toContain('crm.objects.deals.read')
  })

  it('never includes contacts.read (PII)', () => {
    const url = buildHubSpotAuthorizeUrl('c', 'https://cb.co', 's')
    expect(url).not.toContain('contacts.read')
  })
})

// ── parseCallbackParams ───────────────────────────────────────

describe('parseCallbackParams', () => {
  it('parses code and state from callback URL', () => {
    const result = parseCallbackParams('https://example.com/callback?code=abc123&state=state-xyz')
    expect(result).toEqual({ code: 'abc123', state: 'state-xyz' })
  })

  it('returns error when OAuth provider returns error', () => {
    const result = parseCallbackParams('https://example.com/callback?error=access_denied&state=s')
    expect(result?.error).toBe('access_denied')
  })

  it('returns null for missing code', () => {
    const result = parseCallbackParams('https://example.com/callback?state=s')
    expect(result).toBeNull()
  })

  it('returns null for missing state', () => {
    const result = parseCallbackParams('https://example.com/callback?code=c')
    expect(result).toBeNull()
  })

  it('returns null for invalid URL', () => {
    const result = parseCallbackParams('not-a-url')
    expect(result).toBeNull()
  })
})

// ── isTokenExpiringSoon ───────────────────────────────────────

describe('isTokenExpiringSoon', () => {
  it('returns false for null expiresAt (long-lived token)', () => {
    expect(isTokenExpiringSoon(null)).toBe(false)
  })

  it('returns false for undefined expiresAt', () => {
    expect(isTokenExpiringSoon(undefined)).toBe(false)
  })

  it('returns false when token expires in 3 hours (buffer = 1h)', () => {
    const future = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()
    expect(isTokenExpiringSoon(future)).toBe(false)
  })

  it('returns true when token expires in 30 minutes (buffer = 1h)', () => {
    const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString()
    expect(isTokenExpiringSoon(soon)).toBe(true)
  })

  it('returns true when token is already expired', () => {
    const past = new Date(Date.now() - 1000).toISOString()
    expect(isTokenExpiringSoon(past)).toBe(true)
  })

  it('respects custom buffer', () => {
    const in2h = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    // With 3h buffer, 2h remaining = expiring soon
    expect(isTokenExpiringSoon(in2h, 3 * 60 * 60 * 1000)).toBe(true)
    // With 1h buffer, 2h remaining = not expiring soon
    expect(isTokenExpiringSoon(in2h, 1 * 60 * 60 * 1000)).toBe(false)
  })
})

// ── buildIntegrationSummary ───────────────────────────────────

describe('buildIntegrationSummary', () => {
  it('returns disconnected summary for null integration', () => {
    const result = buildIntegrationSummary(null, 'stripe')
    expect(result).toEqual({
      provider: 'stripe',
      connected: false,
      provider_account_id: null,
      scopes: [],
      status: 'pending',
    })
  })

  it('returns connected summary for active integration', () => {
    const result = buildIntegrationSummary({
      provider: 'stripe',
      provider_account_id: 'acct_123',
      scopes: ['read_only'],
      status: 'active',
    }, 'stripe')
    expect(result.connected).toBe(true)
    expect(result.provider_account_id).toBe('acct_123')
    expect(result.scopes).toEqual(['read_only'])
    expect(result.status).toBe('active')
  })

  it('returns not connected for revoked integration', () => {
    const result = buildIntegrationSummary({
      provider: 'hubspot',
      provider_account_id: 'hub_456',
      scopes: null,
      status: 'revoked',
    }, 'hubspot')
    expect(result.connected).toBe(false)
    expect(result.status).toBe('revoked')
    expect(result.scopes).toEqual([])
  })
})

// ── Scope constants ───────────────────────────────────────────

describe('Scope constants', () => {
  it('STRIPE_SCOPES contains read_write', () => {
    expect(STRIPE_SCOPES).toEqual(['read_write'])
  })

  it('HUBSPOT_SCOPES contains companies.read and deals.read', () => {
    expect(HUBSPOT_SCOPES).toContain('crm.objects.companies.read')
    expect(HUBSPOT_SCOPES).toContain('crm.objects.deals.read')
  })

  it('HUBSPOT_SCOPES never contains contacts.read (PII)', () => {
    expect(HUBSPOT_SCOPES).not.toContain('crm.objects.contacts.read')
    expect(HUBSPOT_SCOPES).not.toContain('contacts.read')
  })
})
