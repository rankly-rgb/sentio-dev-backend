// ============================================================
// Supabase Vault — Helper pour stocker/lire des secrets chiffres
// Utilise vault.secrets (chiffrement AES-256-GCM cote serveur)
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
    .from('vault.decrypted_secrets')
    .select('decrypted_secret')
    .eq('id', vaultSecretId)
    .maybeSingle()

  if (error || !data) return null
  return data.decrypted_secret
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
    .from('vault.secrets')
    .insert({
      secret: value,
      name,
      ...(description ? { description } : {}),
    })
    .select('id')
    .single()

  if (error || !data) {
    throw new Error(`Failed to store secret in vault: ${error?.message ?? 'unknown error'}`)
  }
  return data.id
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
    .from('vault.secrets')
    .update({ secret: newValue })
    .eq('id', vaultSecretId)

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
    .from('vault.secrets')
    .delete()
    .eq('id', vaultSecretId)

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
