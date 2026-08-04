// isCronLockHeld — auto-vérification adversariale du 2026-08-04
// (IMPLEMENTATION_LOG.md) : ajouté pour que stripe-webhook puisse détecter,
// en lecture seule, qu'un sync-stripe (normal ou restatement_mode) tourne
// actuellement pour un org, et différer en conséquence l'écriture de
// accounts.mrr_cents / la classification de mouvement.
import { describe, it, expect } from 'vitest'
import { isCronLockHeld } from '../functions/_shared/cron-lock'

function mockSupabase(row: { expires_at: string } | null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: row, error: null }),
        }),
      }),
    }),
  } as unknown as Parameters<typeof isCronLockHeld>[0]
}

describe('isCronLockHeld', () => {
  it('aucune ligne cron_locks pour cette clé → false (pas de sync en cours)', async () => {
    const supabase = mockSupabase(null)
    expect(await isCronLockHeld(supabase, 'sync-stripe-org-1')).toBe(false)
  })

  it('ligne présente avec expires_at dans le futur → true (sync en cours)', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const supabase = mockSupabase({ expires_at: future })
    expect(await isCronLockHeld(supabase, 'sync-stripe-org-1')).toBe(true)
  })

  it('ligne présente mais expires_at dans le passé → false (lock périmé, pas nettoyé mais plus tenu)', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const supabase = mockSupabase({ expires_at: past })
    expect(await isCronLockHeld(supabase, 'sync-stripe-org-1')).toBe(false)
  })
})
