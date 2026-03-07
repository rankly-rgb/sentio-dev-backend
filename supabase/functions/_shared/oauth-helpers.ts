// ============================================================
// OAuth Helpers — Fonctions pures testables avec Vitest
// Pas d'imports Deno/jsr — uniquement des helpers de validation
// et de construction pour les flux OAuth Stripe/HubSpot.
// ============================================================

export type OAuthProvider = 'stripe' | 'hubspot'

export interface OAuthState {
  organization_id: string
  provider: OAuthProvider
  state: string
  expires_at: string
  redirect_after?: string
}

// ── Scopes autorises par provider ─────────────────────────────
// Zero-PII : jamais de contacts.read (HubSpot) ni de write (Stripe)

export const STRIPE_SCOPES = ['read_only'] as const
export const HUBSPOT_SCOPES = ['crm.objects.companies.read', 'crm.objects.deals.read'] as const

// ── Validation ────────────────────────────────────────────────

export function isValidProvider(provider: string): provider is OAuthProvider {
  return provider === 'stripe' || provider === 'hubspot'
}

export function isStateExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() <= Date.now()
}

export function isValidRedirectUrl(url: string | null | undefined): boolean {
  if (!url) return true // redirect_after est optionnel
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}

// ── Construction URLs OAuth ───────────────────────────────────

export function buildStripeAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: STRIPE_SCOPES[0],
    state,
    redirect_uri: redirectUri,
  })
  return `https://connect.stripe.com/oauth/authorize?${params.toString()}`
}

export function buildHubSpotAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: HUBSPOT_SCOPES.join(' '),
    state,
  })
  return `https://app.hubspot.com/oauth/authorize?${params.toString()}`
}

// ── Parsing callback ──────────────────────────────────────────

export interface OAuthCallbackParams {
  code: string
  state: string
  error?: string
}

export function parseCallbackParams(url: string): OAuthCallbackParams | null {
  try {
    const parsed = new URL(url)
    const code = parsed.searchParams.get('code')
    const state = parsed.searchParams.get('state')
    const error = parsed.searchParams.get('error') ?? undefined

    if (error) return { code: '', state: state ?? '', error }
    if (!code || !state) return null

    return { code, state }
  } catch {
    return null
  }
}

// ── Token expiry check (HubSpot = 6h, Stripe = long-lived) ───

export function isTokenExpiringSoon(
  expiresAt: string | null | undefined,
  bufferMs = 60 * 60 * 1000, // 1h par defaut
): boolean {
  if (!expiresAt) return false // long-lived token (Stripe)
  return new Date(expiresAt).getTime() - Date.now() < bufferMs
}

// ── Status derivation ─────────────────────────────────────────

export type IntegrationStatus = 'active' | 'pending' | 'revoked' | 'expired'

export interface IntegrationSummary {
  provider: OAuthProvider
  connected: boolean
  provider_account_id: string | null
  scopes: string[]
  status: IntegrationStatus
}

export function buildIntegrationSummary(
  integration: {
    provider: string
    provider_account_id: string | null
    scopes: string[] | null
    status: string
  } | null,
  provider: OAuthProvider,
): IntegrationSummary {
  if (!integration) {
    return {
      provider,
      connected: false,
      provider_account_id: null,
      scopes: [],
      status: 'pending',
    }
  }
  return {
    provider: provider,
    connected: integration.status === 'active',
    provider_account_id: integration.provider_account_id,
    scopes: integration.scopes ?? [],
    status: integration.status as IntegrationStatus,
  }
}
