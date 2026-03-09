// ============================================================
// Credential Helpers — Fonctions pures testables avec Vitest
// Pas d'imports Deno/jsr — logique de resolution de credentials
// pour les syncs Stripe/HubSpot.
// ============================================================

export type IntegrationMethod = 'oauth' | 'api_key'

export interface IntegrationRow {
  vault_access_token_id: string | null
  provider_account_id: string | null
  status: string
  integration_method?: IntegrationMethod | null
  token_expires_at?: string | null
}

// Keep old name as alias for backward compat in tests
export type OAuthIntegrationRow = IntegrationRow

export type CredentialSource =
  | { type: 'oauth'; vaultSecretId: string; providerAccountId: string | null }
  | { type: 'api_key'; vaultSecretId: string; providerAccountId: string | null }
  | { type: 'global_fallback' }

/**
 * Determine la source de credentials pour un sync.
 *
 * Regles :
 * - Si une integration active existe (OAuth ou api_key), le Vault DOIT contenir le token.
 *   Sinon on throw (pas de fallback silencieux sur la cle globale).
 * - Le fallback global n'est autorise que si AUCUNE integration n'existe.
 * - api_key : pas de Stripe-Account header (cle directe du compte).
 * - oauth : Stripe-Account header avec provider_account_id (Connect).
 */
export function resolveCredentialSource(
  integration: IntegrationRow | null,
  vaultSecret: string | null,
  provider: 'stripe' | 'hubspot',
): CredentialSource {
  if (!integration) {
    return { type: 'global_fallback' }
  }

  const method: IntegrationMethod = integration.integration_method ?? 'oauth'

  if (!integration.vault_access_token_id) {
    throw new Error(
      `${provider} integration (${method}) is active but vault_access_token_id is missing. `
      + `Revoke and reconnect ${provider} to fix.`,
    )
  }

  // HubSpot : verifier l'expiration du token (OAuth uniquement)
  if (provider === 'hubspot' && method === 'oauth' && integration.token_expires_at) {
    const expiresAt = new Date(integration.token_expires_at).getTime()
    if (expiresAt <= Date.now()) {
      throw new Error('HubSpot token expired — run refresh-hubspot-tokens first')
    }
  }

  if (!vaultSecret) {
    throw new Error(
      `${provider} token not found in Vault (id: ${integration.vault_access_token_id}). `
      + `Revoke and reconnect ${provider} to fix.`,
    )
  }

  return {
    type: method,
    vaultSecretId: integration.vault_access_token_id,
    providerAccountId: integration.provider_account_id,
  }
}

/**
 * Valide qu'une cle API Stripe a le bon format.
 * Accepte sk_live_ et sk_test_ (pour dev), refuse les cles publishables (pk_).
 */
export function validateStripeApiKey(key: string): { valid: boolean; error?: string } {
  if (!key || typeof key !== 'string') {
    return { valid: false, error: 'Clé API requise' }
  }
  const trimmed = key.trim()
  if (trimmed.startsWith('pk_')) {
    return { valid: false, error: 'Clé publishable (pk_) non acceptée — utilisez la Secret Key (sk_)' }
  }
  if (!trimmed.startsWith('sk_live_') && !trimmed.startsWith('sk_test_') && !trimmed.startsWith('rk_live_') && !trimmed.startsWith('rk_test_')) {
    return { valid: false, error: 'Format invalide — la clé doit commencer par sk_live_, sk_test_, rk_live_ ou rk_test_' }
  }
  if (trimmed.length < 30) {
    return { valid: false, error: 'Clé trop courte' }
  }
  return { valid: true }
}

/**
 * Valide qu'une cle API HubSpot Private App a le bon format.
 * Les Private Apps HubSpot utilisent le prefixe pat- (Personal Access Token).
 */
export function validateHubSpotApiKey(key: string): { valid: boolean; error?: string } {
  if (!key || typeof key !== 'string') {
    return { valid: false, error: 'Clé API HubSpot requise' }
  }
  const trimmed = key.trim()
  if (!trimmed.startsWith('pat-')) {
    return { valid: false, error: 'Format invalide — la clé doit commencer par pat- (Private App Token HubSpot)' }
  }
  if (trimmed.length < 30) {
    return { valid: false, error: 'Clé trop courte' }
  }
  return { valid: true }
}
