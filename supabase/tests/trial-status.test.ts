import { describe, it, expect } from 'vitest'
import { computeTrialStatus } from '../functions/_shared/trial-status.ts'

// _shared/trial-status.ts a zéro import Deno-natif (que des types +
// Date/Math) — importé directement ici, PAS de copie miroir. Convention
// mrr-engine.test.ts, pas subscription-tiers.test.ts (voir CHANGELOG_STABILITY
// pour le risque des copies miroir : admin-proxy.test.ts en a produit une qui
// affirmait l'inverse du comportement réel).

const DAY_MS = 24 * 60 * 60 * 1000

describe('computeTrialStatus', () => {
  it('free tier, trial_ends_at in the future → active, not expired', () => {
    const now = Date.now()
    const endsAt = new Date(now + 10 * DAY_MS).toISOString()
    const status = computeTrialStatus('free', endsAt, now)
    expect(status.is_trial_active).toBe(true)
    expect(status.is_trial_expired).toBe(false)
    expect(status.trial_days_remaining).toBe(10)
  })

  it('free tier, trial_ends_at in the past → expired, not active, 0 days remaining', () => {
    const now = Date.now()
    const endsAt = new Date(now - 5 * DAY_MS).toISOString()
    const status = computeTrialStatus('free', endsAt, now)
    expect(status.is_trial_active).toBe(false)
    expect(status.is_trial_expired).toBe(true)
    expect(status.trial_days_remaining).toBe(0)
  })

  it('free tier, trial_ends_at exactly now → still active (boundary is inclusive, not yet past)', () => {
    const now = Date.now()
    const status = computeTrialStatus('free', new Date(now).toISOString(), now)
    expect(status.is_trial_expired).toBe(false)
    expect(status.is_trial_active).toBe(true)
  })

  it('free tier, trial_ends_at one millisecond in the past → expired', () => {
    const now = Date.now()
    const status = computeTrialStatus('free', new Date(now - 1).toISOString(), now)
    expect(status.is_trial_expired).toBe(true)
    expect(status.is_trial_active).toBe(false)
  })

  it('free tier, trial_ends_at null (data absent) → neither active nor expired', () => {
    // "no data ≠ neutral data" : l'absence de trial_ends_at ne doit jamais
    // se lire comme "expiré" — sans quoi un trou de données bloquerait un
    // compte au lieu d'un signal explicite de statut inconnu.
    const status = computeTrialStatus('free', null, Date.now())
    expect(status.is_trial_active).toBe(false)
    expect(status.is_trial_expired).toBe(false)
    expect(status.trial_days_remaining).toBe(0)
  })

  it('rounds partial days up (36h remaining → 2 days, not 1)', () => {
    const now = Date.now()
    const endsAt = new Date(now + 36 * 60 * 60 * 1000).toISOString()
    const status = computeTrialStatus('free', endsAt, now)
    expect(status.trial_days_remaining).toBe(2)
  })

  it.each(['growth', 'scale', 'enterprise'] as const)(
    'paid tier (%s) is never active nor expired, even with a stale trial_ends_at in the past',
    (planType) => {
      const now = Date.now()
      const staleEndsAt = new Date(now - 30 * DAY_MS).toISOString()
      const status = computeTrialStatus(planType, staleEndsAt, now)
      expect(status.is_trial_active).toBe(false)
      expect(status.is_trial_expired).toBe(false)
      expect(status.trial_days_remaining).toBe(0)
    },
  )

  it('always echoes back plan_type and trial_ends_at unchanged', () => {
    const endsAt = new Date().toISOString()
    const status = computeTrialStatus('scale', endsAt, Date.now())
    expect(status.plan_type).toBe('scale')
    expect(status.trial_ends_at).toBe(endsAt)
  })
})
