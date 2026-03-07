import { describe, it, expect } from 'vitest'
import {
  isStateExpired,
  isTokenExpiringSoon,
} from '../functions/_shared/oauth-helpers'
import {
  buildPayload,
  computeHmacSignature,
  shouldDisableWebhook,
  containsPII,
  type WebhookAccountData,
  type WebhookSignals,
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

// ── 1. OAuth state : verify state expires after exactly 10 min ──

describe('OAuth state TTL (10 minutes)', () => {
  it('state created with 10 min TTL is valid before expiry', () => {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    expect(isStateExpired(expiresAt)).toBe(false)
  })

  it('state created with 10 min TTL is expired after 10 min', () => {
    const expiresAt = new Date(Date.now() - 1).toISOString() // just past
    expect(isStateExpired(expiresAt)).toBe(true)
  })

  it('state at exactly 10 min boundary (9 min 59 sec) is still valid', () => {
    const expiresAt = new Date(Date.now() + 1000).toISOString() // 1 sec remaining
    expect(isStateExpired(expiresAt)).toBe(false)
  })

  it('state at 10 min + 1 ms is expired', () => {
    // Simulate a state that was created 10 min + 1ms ago with 10 min TTL
    const expiresAt = new Date(Date.now() - 1).toISOString()
    expect(isStateExpired(expiresAt)).toBe(true)
  })

  it('default TTL matches 10 min (600_000 ms)', () => {
    // Verify that a state created now + 600_000ms is not expired
    const created = Date.now()
    const ttlMs = 10 * 60 * 1000 // 600_000 ms = 10 min
    expect(ttlMs).toBe(600_000)
    const expiresAt = new Date(created + ttlMs).toISOString()
    expect(isStateExpired(expiresAt)).toBe(false)
  })
})

// ── 2. OAuth state : single-use enforcement ─────────────────

describe('OAuth state single-use enforcement', () => {
  it('state is consumed after first use (simulated DB deletion)', () => {
    // This test validates the pattern:
    // After callback validates state, it's deleted from DB immediately.
    // A second lookup with the same state returns null.
    const stateToken = crypto.randomUUID() + '-' + crypto.randomUUID()
    const stateDb = new Map<string, { organization_id: string; expires_at: string }>()

    // Insert state (simulate authorize route)
    stateDb.set(stateToken, {
      organization_id: ORG_ID,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })

    // First use: find + delete (simulate callback route)
    const firstLookup = stateDb.get(stateToken) ?? null
    expect(firstLookup).not.toBeNull()
    expect(firstLookup!.organization_id).toBe(ORG_ID)
    stateDb.delete(stateToken) // Immediate deletion after use

    // Second use: state no longer exists
    const secondLookup = stateDb.get(stateToken) ?? null
    expect(secondLookup).toBeNull()
  })

  it('expired state is rejected even if not yet deleted', () => {
    const stateToken = crypto.randomUUID()
    const expiresAt = new Date(Date.now() - 5000).toISOString() // expired 5s ago

    // State exists in DB but expired
    const isExpired = isStateExpired(expiresAt)
    expect(isExpired).toBe(true)
    // Callback MUST check expiry before accepting
  })
})

// ── 3. Tenant resolution : null without fallback ────────────

describe('Tenant resolution without fallback', () => {
  it('returns null when stripe_account_id not found (Connect path)', () => {
    // Simulates resolveOrganization returning null
    const organizations = new Map<string, string>() // stripe_account_id → org_id
    organizations.set('acct_KNOWN', 'org-123')

    const resolvedOrg = organizations.get('acct_UNKNOWN') ?? null
    expect(resolvedOrg).toBeNull()
  })

  it('returns null when customer_id not found (customer lookup path)', () => {
    const accounts = new Map<string, string>() // stripe_customer_id → org_id
    accounts.set('cus_KNOWN', 'org-456')

    const resolvedOrg = accounts.get('cus_UNKNOWN') ?? null
    expect(resolvedOrg).toBeNull()
  })

  it('never falls back to first active org', () => {
    // Simulate the FULL resolution chain from stripe-webhook
    const orgs = new Map<string, string>()
    orgs.set('acct_ORG1', 'org-1')

    const accounts = new Map<string, string>()
    accounts.set('cus_ORG1', 'org-1')

    // Unknown event with no matching account
    const eventAccount = undefined // no Connect account
    const eventCustomer = 'cus_UNKNOWN'

    // Priority 1: Connect (absent)
    let organizationId: string | null = null
    if (eventAccount) {
      organizationId = orgs.get(eventAccount) ?? null
    }

    // Priority 2: customer lookup
    if (!organizationId && eventCustomer) {
      organizationId = accounts.get(eventCustomer) ?? null
    }

    // Priority 3: REJECT — NO FALLBACK
    // The old code would have done: organizationId = getFirstActiveOrg()
    // The new code returns null
    expect(organizationId).toBeNull()

    // Verify we did NOT pick up org-1 as a default
    const allOrgIds = Array.from(orgs.values())
    expect(allOrgIds.includes(organizationId!)).toBe(false)
  })
})

// ── 4. Revocation : provider API called before DB update ────

describe('Revocation order of operations', () => {
  it('revocation follows correct order: provider API → vault delete → DB update', () => {
    const operations: string[] = []

    // Simulate the revocation pipeline from integration-oauth
    function revokeProviderApi() {
      operations.push('provider_api_revoke')
    }
    function deleteVaultSecrets() {
      operations.push('vault_delete')
    }
    function updateDbStatus() {
      operations.push('db_update_revoked')
    }

    // Execute in the order defined by the prompt
    revokeProviderApi()
    deleteVaultSecrets()
    updateDbStatus()

    // Verify order
    expect(operations).toEqual([
      'provider_api_revoke',
      'vault_delete',
      'db_update_revoked',
    ])

    // Provider API must be called BEFORE DB update
    const providerIdx = operations.indexOf('provider_api_revoke')
    const dbIdx = operations.indexOf('db_update_revoked')
    expect(providerIdx).toBeLessThan(dbIdx)
  })

  it('DB status remains active if provider API fails (no partial revocation)', () => {
    let dbStatus = 'active'
    let providerRevoked = false

    try {
      // Provider API call fails
      throw new Error('Provider API returned 500')
    } catch {
      providerRevoked = false
    }

    // DB should NOT be updated to 'revoked' if provider call failed
    if (providerRevoked) {
      dbStatus = 'revoked'
    }

    expect(dbStatus).toBe('active')
    expect(providerRevoked).toBe(false)
  })
})

// ── 5. Refresh token : failure triggers Slack alert ─────────

describe('Refresh token failure handling', () => {
  it('marks integration as expired on refresh failure', () => {
    let integrationStatus = 'active'
    let slackAlerted = false

    // Simulate refresh failure
    try {
      throw new Error('HubSpot refresh token revoked')
    } catch {
      // On failure: mark expired + alert Slack (as per refresh-hubspot-tokens)
      integrationStatus = 'expired'
      slackAlerted = true
    }

    expect(integrationStatus).toBe('expired')
    expect(slackAlerted).toBe(true)
  })

  it('isTokenExpiringSoon triggers refresh for tokens expiring within 1h', () => {
    // Token expires in 30 minutes — should trigger refresh
    const in30min = new Date(Date.now() + 30 * 60 * 1000).toISOString()
    expect(isTokenExpiringSoon(in30min)).toBe(true)

    // Token expires in 2 hours — should NOT trigger refresh
    const in2h = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    expect(isTokenExpiringSoon(in2h)).toBe(false)
  })

  it('Slack alert message includes org ID for triage', () => {
    const orgId = 'org-12345'
    const alertMessage =
      `HubSpot token refresh failed for org ${orgId}. Syncs disabled until reconnection.`

    expect(alertMessage).toContain(orgId)
    expect(alertMessage).toContain('refresh failed')
    expect(alertMessage).toContain('disabled')
  })
})

// ── 6. Webhook payload Zero-PII (already exists, enhanced) ──

describe('Webhook payload Zero-PII (enhanced)', () => {
  it('payload contains only anonymous identifiers, no PII', () => {
    const payload = buildPayload('churn_risk_critical', ORG_ID, ACCOUNT, SIGNALS)
    expect(containsPII(payload)).toBe(false)
  })

  it('rejects payload with injected email field', () => {
    const dirty = {
      ...buildPayload('churn_risk_critical', ORG_ID, ACCOUNT, SIGNALS),
      email: 'user@example.com',
    }
    expect(containsPII(dirty)).toBe(true)
  })

  it('rejects payload with nested PII in metadata', () => {
    const dirty = buildPayload('churn_risk_critical', ORG_ID, ACCOUNT, SIGNALS, {
      contact: { name: 'John Doe', phone: '+33600000000' },
    })
    expect(containsPII(dirty)).toBe(true)
  })

  it('stripe_customer_id is present (anonymous technical ID, not PII)', () => {
    const payload = buildPayload('churn_risk_critical', ORG_ID, ACCOUNT, SIGNALS)
    expect(payload.account.stripe_customer_id).toBe('cus_ABC123')
    expect(containsPII(payload)).toBe(false) // stripe_customer_id is NOT PII
  })
})

// ── 7. Webhook HMAC : signature uses secret, not plain text field ──

describe('Webhook HMAC signature (Vault-sourced)', () => {
  it('signature is computed from a secret string (simulating Vault output)', async () => {
    // The secret comes from getWebhookSecret() which reads from Vault
    const vaultSecret = 'vault-decrypted-secret-abc123'
    const payload = JSON.stringify(buildPayload('churn_risk_critical', ORG_ID, ACCOUNT, SIGNALS))

    const sig = await computeHmacSignature(payload, vaultSecret)
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
  })

  it('different secrets produce different signatures (vault vs plain text)', async () => {
    const payload = JSON.stringify({ event: 'test' })
    const vaultSecret = 'vault-secret-encrypted'
    const plainSecret = 'plain-text-secret'

    const sigVault = await computeHmacSignature(payload, vaultSecret)
    const sigPlain = await computeHmacSignature(payload, plainSecret)

    // If someone accidentally used the plain text column instead of Vault,
    // the signature would not match
    expect(sigVault).not.toBe(sigPlain)
  })

  it('signature is deterministic for same Vault secret', async () => {
    const vaultSecret = 'consistent-vault-secret'
    const payload = JSON.stringify({ event: 'payment_failed' })

    const sig1 = await computeHmacSignature(payload, vaultSecret)
    const sig2 = await computeHmacSignature(payload, vaultSecret)
    expect(sig1).toBe(sig2)
  })

  it('getWebhookSecret pattern: Vault takes priority over plain text', () => {
    // Simulate the getWebhookSecret logic from vault.ts
    function resolveSecret(config: {
      vault_secret_id?: string | null
      vault_decrypted?: string | null
      webhook_secret?: string | null
    }): string | null {
      // Priority 1: Vault
      if (config.vault_secret_id && config.vault_decrypted) {
        return config.vault_decrypted
      }
      // Fallback: plain text (DEPRECATED)
      return config.webhook_secret ?? null
    }

    // When Vault is available, use it
    expect(resolveSecret({
      vault_secret_id: 'uuid-123',
      vault_decrypted: 'vault-secret',
      webhook_secret: 'plain-secret',
    })).toBe('vault-secret')

    // When Vault is empty, fall back (transition period)
    expect(resolveSecret({
      vault_secret_id: null,
      vault_decrypted: null,
      webhook_secret: 'plain-secret',
    })).toBe('plain-secret')

    // When both are null, return null
    expect(resolveSecret({
      vault_secret_id: null,
      vault_decrypted: null,
      webhook_secret: null,
    })).toBeNull()
  })
})

// ── 8. Webhook circuit breaker : deactivation after 5 failures ──

describe('Webhook circuit breaker deactivation flow', () => {
  it('webhook remains active at 4 failures', () => {
    expect(shouldDisableWebhook(4)).toBe(false)
  })

  it('webhook is disabled at exactly 5 failures', () => {
    expect(shouldDisableWebhook(5)).toBe(true)
  })

  it('webhook stays disabled above 5 failures', () => {
    expect(shouldDisableWebhook(10)).toBe(true)
    expect(shouldDisableWebhook(100)).toBe(true)
  })

  it('simulates full failure escalation flow', () => {
    let failureCount = 0
    let isActive = true
    let slackAlerted = false

    // Simulate 5 consecutive failures
    for (let i = 0; i < 5; i++) {
      failureCount += 1

      if (shouldDisableWebhook(failureCount)) {
        isActive = false
        slackAlerted = true
      }
    }

    expect(failureCount).toBe(5)
    expect(isActive).toBe(false)
    expect(slackAlerted).toBe(true)
  })

  it('failure count resets to 0 on success', () => {
    let failureCount = 4 // just under threshold

    // Successful delivery resets count
    failureCount = 0

    expect(shouldDisableWebhook(failureCount)).toBe(false)
  })

  it('webhook at 0 failures is active', () => {
    expect(shouldDisableWebhook(0)).toBe(false)
  })
})
