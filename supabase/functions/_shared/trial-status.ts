// ============================================================
// trial-status.ts — Calcul pur du statut de trial d'une organisation
//
// Consommé par l'Edge Function `trial-status` (contrat frontend
// `src/lib/types/trial.ts::TrialStatus`, déjà construit et testé côté
// frontend — `useTrialStatus`/`TrialBanner` existaient sans jamais avoir
// de données réelles, faute de cet endpoint) et par `assertTrialActive`
// (_shared/auth.ts) pour l'enforcement 402 sur les endpoints coeur produit.
// ============================================================

import type { SubscriptionTierKey } from './subscription-tiers.ts'

const MS_PER_DAY = 24 * 60 * 60 * 1000

export interface TrialStatus {
  plan_type: SubscriptionTierKey
  trial_ends_at: string | null
  trial_days_remaining: number
  is_trial_active: boolean
  is_trial_expired: boolean
}

/**
 * Le concept de trial ne s'applique qu'au tier 'free' — un compte déjà
 * payant (growth/scale/enterprise) n'est jamais "en trial", qu'il ait ou
 * non un vieux `trial_ends_at` en base (ex. upgrade fait pendant la
 * période d'essai, la colonne n'est jamais nettoyée). Idem si
 * `trial_ends_at` est absent : "no data ≠ neutral data" (docs/openspec.md,
 * CLAUDE.md) — l'absence de la colonne ne doit jamais se lire comme "trial
 * expiré", elle se lit comme "non applicable", pour ne jamais bloquer un
 * compte par un trou de donnée plutôt qu'une vraie expiration.
 */
export function computeTrialStatus(
  planType: SubscriptionTierKey,
  trialEndsAtIso: string | null,
  nowMs: number,
): TrialStatus {
  if (planType !== 'free' || trialEndsAtIso === null) {
    return {
      plan_type: planType,
      trial_ends_at: trialEndsAtIso,
      trial_days_remaining: 0,
      is_trial_active: false,
      is_trial_expired: false,
    }
  }

  const endsAtMs = new Date(trialEndsAtIso).getTime()
  const isExpired = endsAtMs < nowMs
  const daysRemaining = isExpired ? 0 : Math.ceil((endsAtMs - nowMs) / MS_PER_DAY)

  return {
    plan_type: planType,
    trial_ends_at: trialEndsAtIso,
    trial_days_remaining: daysRemaining,
    is_trial_active: !isExpired,
    is_trial_expired: isExpired,
  }
}
