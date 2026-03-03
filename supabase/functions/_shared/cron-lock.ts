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
