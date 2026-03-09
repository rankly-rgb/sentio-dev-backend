// ============================================================
// Supabase Vault — Helper pour stocker/lire des secrets chiffres
// Utilise vault.secrets via RPC SQL (le schema vault n'est pas
// accessible via .from() qui cible le schema public par defaut)
// Les valeurs dechiffrees ne sont JAMAIS loggees.
// ============================================================

import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

/**
 * Lit un secret depuis Supabase Vault (vue dechiffree).
 * Retourne null si le secret n'existe pas.
 */
export async function getVaultSecret(
  supabase: SupabaseClient,
  vaultSecretId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .rpc('vault_read_secret', { secret_id: vaultSecretId })

  if (error) {
    console.error(JSON.stringify({
      level: 'error',
      module: 'vault',
      message: 'vault_read_secret RPC failed',
      secret_id: vaultSecretId,
      error: error.message,
      error_code: error.code,
    }))
    return null
  }

  if (!data || data.length === 0) {
    console.warn(JSON.stringify({
      level: 'warn',
      module: 'vault',
      message: 'Vault secret not found — ID may be stale or secret was never persisted',
      secret_id: vaultSecretId,
    }))
    return null
  }

  return data[0].decrypted_secret
}

/**
 * Stocke un nouveau secret dans Supabase Vault.
 * Retourne l'UUID du secret cree.
 */
export async function storeVaultSecret(
  supabase: SupabaseClient,
  value: string,
  name: string,
  description?: string,
): Promise<string> {
  const { data, error } = await supabase
    .rpc('vault_store_secret', {
      p_secret: value,
      p_name: name,
      p_description: description ?? '',
    })

  if (error || !data) {
    throw new Error(`Failed to store secret in vault: ${error?.message ?? 'unknown error'}`)
  }
  return data as string
}

/**
 * Met a jour un secret existant dans Supabase Vault.
 */
export async function updateVaultSecret(
  supabase: SupabaseClient,
  vaultSecretId: string,
  newValue: string,
): Promise<void> {
  const { error } = await supabase
    .rpc('vault_update_secret', {
      secret_id: vaultSecretId,
      new_secret: newValue,
    })

  if (error) {
    throw new Error(`Failed to update vault secret: ${error.message}`)
  }
}

/**
 * Supprime un secret du Vault.
 */
export async function deleteVaultSecret(
  supabase: SupabaseClient,
  vaultSecretId: string,
): Promise<void> {
  const { error } = await supabase
    .rpc('vault_delete_secret', { secret_id: vaultSecretId })

  if (error) {
    throw new Error(`Failed to delete vault secret: ${error.message}`)
  }
}

/**
 * Lit un webhook secret : Vault en priorite, fallback sur la colonne en clair.
 * Periode de transition uniquement — a supprimer quand webhook_secret sera DROP.
 */
export async function getWebhookSecret(
  supabase: SupabaseClient,
  config: { vault_secret_id?: string | null; webhook_secret?: string | null },
): Promise<string | null> {
  // Priorite 1 : Vault
  if (config.vault_secret_id) {
    const secret = await getVaultSecret(supabase, config.vault_secret_id)
    if (secret) return secret
  }
  // Fallback temporaire : colonne en clair (DEPRECATED)
  return config.webhook_secret ?? null
}
