// ============================================================
// Supabase Vault — Helper pour stocker/lire des secrets chiffrés
// Utilise vault.secrets via RPC SQL (le schema vault n'est pas
// accessible via .from() qui cible le schema public par défaut)
// Les valeurs déchiffrées ne sont JAMAIS loguées.
// ============================================================

import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

/**
 * Lit un secret depuis Supabase Vault (vue déchiffrée).
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
