// ============================================================
// Today Actions — helpers partagés (C2.4a, 2026-08-02)
//
// Source de vérité unique pour la page "Today" : combine les insights actifs
// ET les comptes matchant un playbook actif dans une seule liste d'actions
// priorisées. Avant ce chantier, `get-today-actions` n'existait pas — le
// frontend recalculait tout côté client (`src/lib/types/today-actions.ts`,
// playbooks-only, aucune notion d'insight) d'où la contradiction possible
// "0 priority actions" à côté de "206 critical insights" sur le même écran :
// deux nombres de deux sources totalement indépendantes.
//
// Règle explicite : un insight actif est en lui-même une action prioritaire,
// indépendamment de tout matching playbook — un compte peut donc apparaître
// dans la liste sans qu'aucun playbook ne le cible. S'il existe ≥1 insight
// critique actif, le total ne peut jamais être 0 et le statut ne peut jamais
// être 'stable' (determinePortfolioStatus ci-dessous).
//
// Réutilise evaluateConditions/ConditionGroup de playbook-engine.ts — pas de
// deuxième implémentation du matching eligibility_criteria.
// ============================================================

import { evaluateConditions, type ConditionGroup } from './playbook-engine.ts'

export type PriorityCode = 'P0' | 'P1' | 'P2'

const PRIORITY_RANK: Record<PriorityCode, number> = { P0: 0, P1: 1, P2: 2 }

const INSIGHT_PRIORITY_TO_CODE: Record<string, PriorityCode> = {
  critical: 'P0',
  high: 'P1',
  medium: 'P2',
  low: 'P2',
}

export interface TodayAccountInput {
  id: string
  stripe_customer_id: string | null
  hubspot_company_id: string | null
  display_name: string | null
  health_score: number | null
  churn_risk_score: number | null
  expansion_score: number | null
  mrr_cents: number | null
  plan_tier: string | null
  contract_end_date: string | null
  billing_interval: string | null
}

export interface TodayPlaybookInput {
  id: string
  title: string
  priority: string
  template_category: string | null
  status: string
  eligibility_criteria: ConditionGroup | null
}

export interface TodayInsightInput {
  title: string
  priority: string // 'low' | 'medium' | 'high' | 'critical' — pas de type strict, tolérant aux valeurs inattendues (voir INSIGHT_PRIORITY_TO_CODE fallback)
}

export interface MatchingPlaybook {
  id: string
  title: string
  priority: string
  category: string | null
}

export interface TodayAction {
  account_id: string
  stripe_customer_id: string | null
  display_name: string | null
  hubspot_company_id: string | null
  priority: PriorityCode
  health_score: number | null
  churn_risk_score: number | null
  expansion_score: number | null
  mrr_cents: number
  plan_tier: string | null
  days_to_renewal: number | null
  trigger_reasons: string[]
  matching_playbooks: MatchingPlaybook[]
}

export interface TodayActionsSummary {
  total: number
  by_priority: Record<PriorityCode, number>
  by_category: Record<string, number>
  mrr_at_risk_cents: number
  actions: TodayAction[]
}

export function computeDaysToRenewal(
  contractEndDate: string | null,
  billingInterval: string | null,
  now: number = Date.now(),
): number | null {
  if (!contractEndDate || billingInterval === 'monthly') return null
  const end = new Date(contractEndDate).getTime()
  return Math.ceil((end - now) / (1000 * 60 * 60 * 24))
}

// Priorité de base (churn/renewal), puis élevée si un insight actif est plus
// urgent — un compte avec un insight 'critical' ne peut jamais retomber en
// dessous de P0, quels que soient ses scores.
export function computePriority(
  churnRiskScore: number | null,
  daysToRenewal: number | null,
  insightPriorities: string[],
): PriorityCode {
  const risk = churnRiskScore ?? 0
  let priority: PriorityCode = 'P2'
  if (risk >= 70) priority = 'P0'
  else if (risk >= 50 || (daysToRenewal !== null && daysToRenewal < 60)) priority = 'P1'

  for (const p of insightPriorities) {
    const mapped = INSIGHT_PRIORITY_TO_CODE[p] ?? 'P2'
    if (PRIORITY_RANK[mapped] < PRIORITY_RANK[priority]) priority = mapped
  }

  return priority
}

export function computeTriggerReasons(
  account: TodayAccountInput,
  insightTitles: string[],
): string[] {
  const reasons: string[] = [...insightTitles]

  const churnRisk = account.churn_risk_score ?? 0
  if (churnRisk >= 70) {
    reasons.push(`Critical churn risk (${Math.round(churnRisk)}%)`)
  } else if (churnRisk >= 50) {
    reasons.push(`Moderate churn risk (${Math.round(churnRisk)}%)`)
  }

  const health = account.health_score ?? 100
  if (health < 40) {
    reasons.push(`Low health score (${Math.round(health)}%)`)
  }

  const dtr = computeDaysToRenewal(account.contract_end_date, account.billing_interval)
  if (dtr !== null && dtr <= 60) {
    reasons.push(`Renews in ${dtr}d`)
  }

  const expansion = account.expansion_score ?? 0
  if (expansion >= 70) {
    reasons.push(`Expansion opportunity (${Math.round(expansion)}%)`)
  }

  return reasons
}

// accounts/playbooks/insightsByAccount doivent déjà exclure les comptes
// churnés (D1) — filtrage fait par l'appelant au niveau de la query, pas ici
// (cohérent avec le reste du repo, cf. onboarding-first-win/get-today-status).
export function computeTodayActions(
  accounts: TodayAccountInput[],
  playbooks: TodayPlaybookInput[],
  insightsByAccount: Map<string, TodayInsightInput[]>,
): TodayAction[] {
  const activePlaybooks = playbooks.filter((pb) => pb.status === 'active')
  const accountsById = new Map(accounts.map((a) => [a.id, a]))
  const map = new Map<string, TodayAction>()

  function ensure(account: TodayAccountInput): TodayAction {
    const existing = map.get(account.id)
    if (existing) return existing

    const insights = insightsByAccount.get(account.id) ?? []
    const dtr = computeDaysToRenewal(account.contract_end_date, account.billing_interval)
    const action: TodayAction = {
      account_id: account.id,
      stripe_customer_id: account.stripe_customer_id,
      display_name: account.display_name,
      hubspot_company_id: account.hubspot_company_id,
      priority: computePriority(account.churn_risk_score, dtr, insights.map((i) => i.priority)),
      health_score: account.health_score,
      churn_risk_score: account.churn_risk_score,
      expansion_score: account.expansion_score,
      mrr_cents: account.mrr_cents ?? 0,
      plan_tier: account.plan_tier,
      days_to_renewal: dtr,
      trigger_reasons: computeTriggerReasons(account, insights.map((i) => i.title)),
      matching_playbooks: [],
    }
    map.set(account.id, action)
    return action
  }

  // Comptes matchant un playbook actif
  for (const pb of activePlaybooks) {
    for (const account of accounts) {
      if (!evaluateConditions(pb.eligibility_criteria, account as unknown as Record<string, unknown>)) continue
      const action = ensure(account)
      if (!action.matching_playbooks.some((p) => p.id === pb.id)) {
        action.matching_playbooks.push({
          id: pb.id,
          title: pb.title,
          priority: pb.priority,
          category: pb.template_category,
        })
      }
    }
  }

  // Comptes avec au moins un insight actif — même sans aucun playbook matchant
  // (c'est la correction du chantier : un insight critique est une action
  // prioritaire en soi, pas seulement un déclencheur de playbook).
  for (const [accountId, insights] of insightsByAccount) {
    if (insights.length === 0) continue
    const account = accountsById.get(accountId)
    if (!account) continue
    ensure(account)
  }

  return Array.from(map.values())
}

export function sortTodayActions(actions: TodayAction[]): TodayAction[] {
  return [...actions].sort((a, b) => {
    const pDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    if (pDiff !== 0) return pDiff
    return (b.mrr_cents ?? 0) - (a.mrr_cents ?? 0)
  })
}

export function buildTodayActionsSummary(actions: TodayAction[]): TodayActionsSummary {
  const sorted = sortTodayActions(actions)
  const by_priority: Record<PriorityCode, number> = { P0: 0, P1: 0, P2: 0 }
  const by_category: Record<string, number> = {}
  let mrr_at_risk_cents = 0

  for (const action of sorted) {
    by_priority[action.priority]++
    if (action.priority === 'P0' || action.priority === 'P1') {
      mrr_at_risk_cents += action.mrr_cents ?? 0
    }
    for (const pb of action.matching_playbooks) {
      const cat = pb.category ?? 'other'
      by_category[cat] = (by_category[cat] ?? 0) + 1
    }
  }

  return {
    total: sorted.length,
    by_priority,
    by_category,
    mrr_at_risk_cents,
    actions: sorted,
  }
}

export type PortfolioStatus = 'critical' | 'attention_needed' | 'stable'

// Règle non négociable (C2.4a) : un insight critique actif interdit le
// statut 'stable' ET interdit un total de 0 — plus jamais la juxtaposition
// "portfolio stable" / "0 priority actions" / "206 critical insights"
// trouvée par l'audit.
export function determinePortfolioStatus(
  criticalInsightCount: number,
  totalActions: number,
): PortfolioStatus {
  if (criticalInsightCount > 0) return 'critical'
  if (totalActions > 0) return 'attention_needed'
  return 'stable'
}
