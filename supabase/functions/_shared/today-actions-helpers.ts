// ============================================================
// Today Actions Helpers — Pure functions for grouping actionable accounts
// Used by the "Aujourd'hui" page to organize actions by priority
// No Deno/jsr imports — testable with Vitest
// ============================================================

import { evaluateConditions } from './playbook-engine.ts'
import type { ConditionGroup } from './playbook-engine.ts'
import { computePriority, computeDaysToRenewal } from './export-helpers.ts'

// ── Types ────────────────────────────────────────────────────

export interface TodayAccount {
  id: string
  stripe_customer_id: string | null
  hubspot_company_id: string | null
  health_score: number | null
  churn_risk_score: number | null
  expansion_score: number | null
  mrr_cents: number | null
  plan_tier: string | null
  billing_interval: string | null
  contract_end_date: string | null
  created_at: string | null
}

export interface PlaybookRef {
  id: string
  title: string
  priority: 'critical' | 'high' | 'medium' | 'low'
  template_category: string | null
  eligibility_criteria: ConditionGroup | null
}

export interface TodayAction {
  account_id: string
  stripe_customer_id: string | null
  hubspot_company_id: string | null
  priority: 'P0' | 'P1' | 'P2'
  health_score: number | null
  churn_risk_score: number | null
  expansion_score: number | null
  mrr_cents: number | null
  plan_tier: string | null
  days_to_renewal: number | null
  trigger_reasons: string[]
  matching_playbooks: { id: string; title: string; priority: string; category: string | null }[]
}

export interface TodayActionsSummary {
  total: number
  by_priority: { P0: number; P1: number; P2: number }
  by_category: Record<string, number>
  mrr_at_risk_cents: number
  actions: TodayAction[]
}

// ── Trigger reason computation ───────────────────────────────

export function computeTriggerReasons(account: TodayAccount): string[] {
  const reasons: string[] = []

  if ((account.churn_risk_score ?? 0) >= 70) {
    reasons.push(`Risque churn critique (${Math.round(account.churn_risk_score!)}%)`)
  } else if ((account.churn_risk_score ?? 0) >= 50) {
    reasons.push(`Risque churn modéré (${Math.round(account.churn_risk_score!)}%)`)
  }

  if ((account.health_score ?? 100) < 40) {
    reasons.push(`Santé faible (${Math.round(account.health_score!)}%)`)
  }

  const daysToRenewal = computeDaysToRenewal(
    account.contract_end_date,
    account.billing_interval,
  )
  if (daysToRenewal !== null && daysToRenewal <= 30) {
    reasons.push(`Renouvellement dans ${daysToRenewal}j`)
  } else if (daysToRenewal !== null && daysToRenewal <= 60) {
    reasons.push(`Renouvellement dans ${daysToRenewal}j`)
  }

  if ((account.expansion_score ?? 0) >= 70) {
    reasons.push(`Opportunité expansion (${Math.round(account.expansion_score!)}%)`)
  }

  if ((account.mrr_cents ?? 0) === 0) {
    reasons.push('MRR à zéro')
  }

  return reasons
}

// ── Core grouping logic ──────────────────────────────────────

/**
 * Matches accounts against active playbooks and computes today's actions.
 * Returns a deduplicated list of accounts with their matching playbooks and priority.
 */
export function computeTodayActions(
  accounts: TodayAccount[],
  playbooks: PlaybookRef[],
): TodayAction[] {
  // Map to collect matching playbooks per account
  const accountActions = new Map<string, TodayAction>()

  for (const playbook of playbooks) {
    for (const account of accounts) {
      const matches = evaluateConditions(
        playbook.eligibility_criteria,
        account as unknown as Record<string, unknown>,
      )
      if (!matches) continue

      const existing = accountActions.get(account.id)
      const playbookRef = {
        id: playbook.id,
        title: playbook.title,
        priority: playbook.priority,
        category: playbook.template_category,
      }

      if (existing) {
        // Avoid duplicate playbook refs
        if (!existing.matching_playbooks.some((p) => p.id === playbook.id)) {
          existing.matching_playbooks.push(playbookRef)
        }
      } else {
        const daysToRenewal = computeDaysToRenewal(
          account.contract_end_date,
          account.billing_interval,
        )
        const priority = computePriority(account.churn_risk_score, daysToRenewal)

        accountActions.set(account.id, {
          account_id: account.id,
          stripe_customer_id: account.stripe_customer_id,
          hubspot_company_id: account.hubspot_company_id,
          priority,
          health_score: account.health_score,
          churn_risk_score: account.churn_risk_score,
          expansion_score: account.expansion_score,
          mrr_cents: account.mrr_cents,
          plan_tier: account.plan_tier,
          days_to_renewal: daysToRenewal,
          trigger_reasons: computeTriggerReasons(account),
          matching_playbooks: [playbookRef],
        })
      }
    }
  }

  return Array.from(accountActions.values())
}

/**
 * Sorts actions: P0 first, then P1, then P2. Within each priority, MRR desc.
 */
export function sortTodayActions(actions: TodayAction[]): TodayAction[] {
  const priorityOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2 }
  return [...actions].sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 3
    const pb = priorityOrder[b.priority] ?? 3
    if (pa !== pb) return pa - pb
    return (b.mrr_cents ?? 0) - (a.mrr_cents ?? 0)
  })
}

/**
 * Groups actions by priority and computes summary stats.
 */
export function buildTodayActionsSummary(actions: TodayAction[]): TodayActionsSummary {
  const sorted = sortTodayActions(actions)

  const byPriority = { P0: 0, P1: 0, P2: 0 }
  const byCategory: Record<string, number> = {}
  let mrrAtRiskCents = 0

  for (const action of sorted) {
    byPriority[action.priority]++

    // MRR at risk = all P0 + P1 accounts
    if (action.priority === 'P0' || action.priority === 'P1') {
      mrrAtRiskCents += action.mrr_cents ?? 0
    }

    // Count by playbook category
    for (const pb of action.matching_playbooks) {
      const cat = pb.category ?? 'other'
      byCategory[cat] = (byCategory[cat] ?? 0) + 1
    }
  }

  return {
    total: sorted.length,
    by_priority: byPriority,
    by_category: byCategory,
    mrr_at_risk_cents: mrrAtRiskCents,
    actions: sorted,
  }
}

/**
 * Returns the top N actions per priority level.
 * Useful for the collapsed view showing only top items.
 */
export function getTopActionsByPriority(
  actions: TodayAction[],
  limit: number,
): { P0: TodayAction[]; P1: TodayAction[]; P2: TodayAction[] } {
  const sorted = sortTodayActions(actions)

  const result: { P0: TodayAction[]; P1: TodayAction[]; P2: TodayAction[] } = {
    P0: [],
    P1: [],
    P2: [],
  }

  for (const action of sorted) {
    if (result[action.priority].length < limit) {
      result[action.priority].push(action)
    }
  }

  return result
}

/**
 * Computes a human-readable label for a playbook priority.
 */
export function priorityLabel(priority: 'P0' | 'P1' | 'P2'): string {
  const labels: Record<string, string> = {
    P0: 'Critique',
    P1: 'Haute',
    P2: 'Normale',
  }
  return labels[priority] ?? priority
}

/**
 * Computes a human-readable label for a playbook category.
 */
export function categoryLabel(category: string): string {
  const labels: Record<string, string> = {
    churn_prevention: 'Prévention churn',
    expansion: 'Expansion',
    onboarding: 'Onboarding',
    reactivation: 'Réactivation',
    renewal: 'Renouvellement',
    winback: 'Récupération',
    payment_recovery: 'Recouvrement',
    health_monitoring: 'Suivi santé',
    other: 'Autre',
  }
  return labels[category] ?? category
}
