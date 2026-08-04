import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export async function acquireCronLock(
  supabase: SupabaseClient,
  lockKey: string,
  ttlSeconds = 300
): Promise<boolean> {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000)

  // Clean expired locks first
  const { error: deleteError } = await supabase
    .from('cron_locks')
    .delete()
    .eq('lock_key', lockKey)
    .lt('expires_at', now.toISOString())

  if (deleteError) {
    console.error(`[cron-lock] Failed to clean expired lock "${lockKey}": ${deleteError.message}`)
    // Continue — the insert may still succeed if no expired lock exists
  }

  // Try to insert — fails if lock exists due to UNIQUE(lock_key)
  const { error } = await supabase
    .from('cron_locks')
    .insert({
      lock_key: lockKey,
      locked_at: now.toISOString(),
      locked_by: 'edge-function',
      expires_at: expiresAt.toISOString(),
    })

  if (error) {
    // Distinguish lock contention (expected) from DB errors (unexpected)
    const isConflict = error.message?.includes('duplicate') || error.message?.includes('unique') || error.code === '23505'
    if (!isConflict) {
      console.error(`[cron-lock] Unexpected error acquiring lock "${lockKey}": ${error.message}`)
    }
    return false
  }

  return true
}

export async function releaseCronLock(
  supabase: SupabaseClient,
  lockKey: string
): Promise<void> {
  await supabase.from('cron_locks').delete().eq('lock_key', lockKey)
}

/**
 * Vérification en lecture seule — n'acquiert rien, ne modifie rien.
 * Utilisée par stripe-webhook (docs/openspec.md, IMPLEMENTATION_LOG.md
 * "auto-vérification adversariale" 2026-08-04) pour détecter qu'un
 * sync-stripe (normal ou restatement_mode) tourne actuellement pour cet
 * org, et différer en conséquence l'écriture de accounts.mrr_cents / la
 * classification de mouvement pour cet event — sync-stripe et
 * stripe-webhook n'ont sinon aucune coordination : un event webhook traité
 * pendant un restatement pourrait comparer son "previous" (accounts.mrr_cents
 * lu avant que le restatement n'ait écrit) à un "current" déjà recalculé
 * avec le nouveau moteur, produisant un mouvement mal classé (ex. une
 * vraie expansion lue comme une grosse contraction), et son écriture finale
 * sur `accounts` pourrait être silencieusement écrasée par celle, plus
 * tardive mais basée sur un état Stripe plus ancien, du restatement.
 */
export async function isCronLockHeld(
  supabase: SupabaseClient,
  lockKey: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('cron_locks')
    .select('expires_at')
    .eq('lock_key', lockKey)
    .maybeSingle()

  if (!data) return false
  return new Date(data.expires_at).getTime() > Date.now()
}
