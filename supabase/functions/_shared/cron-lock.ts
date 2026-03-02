import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export async function acquireCronLock(
  supabase: SupabaseClient,
  lockKey: string,
  ttlSeconds = 300
): Promise<boolean> {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000)

  // Clean expired locks first
  await supabase
    .from('cron_locks')
    .delete()
    .eq('lock_key', lockKey)
    .lt('expires_at', now.toISOString())

  // Try to insert — fails if lock exists due to UNIQUE(lock_key)
  const { error } = await supabase
    .from('cron_locks')
    .insert({
      lock_key: lockKey,
      locked_at: now.toISOString(),
      locked_by: 'edge-function',
      expires_at: expiresAt.toISOString(),
    })

  return !error
}

export async function releaseCronLock(
  supabase: SupabaseClient,
  lockKey: string
): Promise<void> {
  await supabase.from('cron_locks').delete().eq('lock_key', lockKey)
}
