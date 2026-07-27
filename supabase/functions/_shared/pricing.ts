// ============================================================
// Pricing — logique pure de gating par palier tarifaire
// Aucune dépendance Supabase (fonctions pures testables)
// cf. specs/003-pricing-billing-implementation/data-model.md
// ============================================================

export const VALID_PLAN_TIERS = ['free', 'growth', 'scale', 'enterprise'] as const
export type PlanTier = typeof VALID_PLAN_TIERS[number]

export interface TierLimits {
  plan_tier: PlanTier
  max_active_accounts: number | null // null = illimité (Enterprise)
  requires_appointment: boolean
  alert_threshold_pct: number
}

export interface GateResult {
  gating_active: boolean
  alert_active: boolean
  usage_pct: number | null
}

/**
 * Calcule le pourcentage d'utilisation de la limite de comptes actifs.
 * `null` si la limite est illimitée (Enterprise) — jamais un pourcentage
 * fabriqué sur une base illimitée.
 */
export function calculateUsagePct(
  activeAccountCount: number,
  maxActiveAccounts: number | null,
): number | null {
  if (maxActiveAccounts === null || maxActiveAccounts <= 0) return null
  return Math.round((activeAccountCount / maxActiveAccounts) * 100)
}

/**
 * Détermine le gating (dépassement) et l'alerte (approche du seuil)
 * pour un palier donné. Un palier `max_active_accounts = null` (Enterprise)
 * n'est jamais gaté ni alerté.
 */
export function checkAccountLimitGate(
  activeAccountCount: number,
  tierLimits: TierLimits,
): GateResult {
  const usagePct = calculateUsagePct(activeAccountCount, tierLimits.max_active_accounts)

  if (tierLimits.max_active_accounts === null) {
    return { gating_active: false, alert_active: false, usage_pct: null }
  }

  return {
    gating_active: activeAccountCount > tierLimits.max_active_accounts,
    alert_active: usagePct !== null && usagePct >= tierLimits.alert_threshold_pct,
    usage_pct: usagePct,
  }
}

/**
 * FR-013 : un downgrade est incohérent si le nombre de comptes actifs
 * dépasse déjà la limite du palier cible — le downgrade doit être
 * bloqué explicitement plutôt qu'autorisé silencieusement.
 */
export function isDowngradeIncoherent(
  targetTierLimits: TierLimits,
  activeAccountCount: number,
): boolean {
  if (targetTierLimits.max_active_accounts === null) return false
  return activeAccountCount > targetTierLimits.max_active_accounts
}
