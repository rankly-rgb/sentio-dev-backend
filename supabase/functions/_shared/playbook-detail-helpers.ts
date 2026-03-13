// ============================================================
// Playbook Detail — Helpers pures pour la RPC get_playbook_full_detail
// Aucune dépendance Supabase (fonctions pures testables)
// ============================================================

import type { PlaybookAction, ConditionGroup, Condition } from './playbook-engine'

// ── Types ────────────────────────────────────────────────────

export type UrgencyLevel = 'urgent' | 'watch' | 'stable'

/** French urgency labels for the eligible accounts RPC */
export type UrgencyLevelFr = 'urgent' | 'surveiller' | 'stable'

export type PlaybookStatusValue = 'draft' | 'active' | 'paused' | 'completed' | 'archived'

export interface ConditionDisplay {
  field: string
  operator: string
  value: unknown
  label: string
}

export interface ActionDisplay {
  step: number
  type: string
  label: string
  detail: string
}

export interface UrgencySummary {
  urgent: number
  watch: number
  stable: number
}

export interface AffectedAccountsSummary {
  total: number
  mrr_at_risk_cents: number
  by_urgency: UrgencySummary
}

export interface ExecutionStatsInput {
  execution_status: string
  account_id: string
  account_converted?: boolean | null
  mrr_recovered_cents?: number | null
  mrr_expansion_cents?: number | null
}

export interface ExecutionStats {
  targeted_count: number
  reached_count: number
  converted_count: number
  mrr_recovered_cents: number
  mrr_expansion_cents: number
  executions_total: number
  executions_completed: number
  executions_failed: number
  executions_in_progress: number
}

export interface AccountForSummary {
  churn_risk_score: number | null
  mrr_cents: number | null
}

export interface EligibleAccountRow {
  account_id: string
  stripe_customer_id: string | null
  mrr_cents: number | null
  churn_risk_score: number | null
  health_score: number | null
  expansion_score: number | null
  urgency: UrgencyLevelFr
}

export interface EligibleAccountsSummary {
  total: number
  mrr_at_risk_cents: number
  urgent_count: number
  surveiller_count: number
  stable_count: number
}

// ── Allowed transitions ──────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ['active', 'archived'],
  active: ['draft', 'archived'],
  paused: ['active', 'archived'],
  completed: ['archived'],
  archived: [],
}

/**
 * Vérifie si une transition de statut est autorisée.
 */
export function isTransitionAllowed(
  currentStatus: string,
  targetStatus: string,
): boolean {
  const allowed = ALLOWED_TRANSITIONS[currentStatus]
  if (!allowed) return false
  return allowed.includes(targetStatus)
}

/**
 * Retourne les transitions autorisées depuis un statut donné.
 */
export function getAllowedTransitions(currentStatus: string): string[] {
  return ALLOWED_TRANSITIONS[currentStatus] || []
}

// ── Urgency classification ───────────────────────────────────

/**
 * Classifie un compte par urgence en fonction du churn_risk_score.
 * urgent: >= 70, watch: 40-69, stable: < 40
 */
export function classifyUrgency(churnRiskScore: number | null): UrgencyLevel {
  if (churnRiskScore === null || churnRiskScore === undefined) return 'stable'
  if (churnRiskScore >= 70) return 'urgent'
  if (churnRiskScore >= 40) return 'watch'
  return 'stable'
}

/**
 * Construit le résumé des comptes affectés (total, MRR at risk, urgency).
 */
export function buildAffectedAccountsSummary(
  accounts: AccountForSummary[],
): AffectedAccountsSummary {
  const summary: AffectedAccountsSummary = {
    total: accounts.length,
    mrr_at_risk_cents: 0,
    by_urgency: { urgent: 0, watch: 0, stable: 0 },
  }

  for (const account of accounts) {
    summary.mrr_at_risk_cents += account.mrr_cents ?? 0
    const urgency = classifyUrgency(account.churn_risk_score)
    summary.by_urgency[urgency]++
  }

  return summary
}

// ── Condition labels ─────────────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
  churn_risk_score: 'Score de risque churn',
  health_score: 'Score de santé',
  expansion_score: "Score d'expansion",
  product_usage_score: "Score d'usage produit",
  mrr_cents: 'MRR',
  arr_cents: 'ARR',
  plan_tier: 'Plan',
  seat_count: 'Nombre de sièges',
  seat_limit: 'Limite de sièges',
  billing_interval: 'Intervalle de facturation',
}

const OPERATOR_LABELS: Record<string, string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  in: 'parmi',
  not_in: 'hors de',
}

function formatConditionValue(field: string, value: unknown): string {
  if (field === 'mrr_cents' || field === 'arr_cents') {
    const num = Number(value)
    if (!isNaN(num)) return `${(num / 100).toFixed(0)} €`
  }
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

/**
 * Génère un label lisible en français pour une condition.
 */
export function buildConditionLabel(condition: Condition): string {
  const fieldLabel = FIELD_LABELS[condition.field] || condition.field
  const opLabel = OPERATOR_LABELS[condition.operator] || condition.operator
  const valueStr = formatConditionValue(condition.field, condition.value)
  return `${fieldLabel} ${opLabel} ${valueStr}`
}

/**
 * Convertit les conditions d'un playbook en format d'affichage avec labels.
 */
export function buildConditionsDisplay(
  eligibilityCriteria: ConditionGroup | null | undefined,
): ConditionDisplay[] {
  if (!eligibilityCriteria || !eligibilityCriteria.conditions) return []

  return eligibilityCriteria.conditions.map((cond) => ({
    field: cond.field,
    operator: cond.operator,
    value: cond.value,
    label: buildConditionLabel(cond),
  }))
}

// ── Action labels ────────────────────────────────────────────

const ACTION_TYPE_LABELS: Record<string, string> = {
  slack_notify: 'Notification Slack',
  create_task: 'Créer une tâche',
  assign_owner: 'Assigner un responsable',
  update_tag: 'Mettre à jour un tag',
  log_note: 'Ajouter une note',
  schedule_review: 'Planifier une revue',
  flag_for_review: 'Signaler pour revue',
  send_email: 'Envoyer un email',
  send_email_hubspot: 'Email via HubSpot',
}

function buildActionDetail(action: PlaybookAction): string {
  const config = action.config || {}
  switch (action.type) {
    case 'slack_notify': {
      const channel = config.channel || ''
      const template = config.template || config.message_template || ''
      return [channel, template].filter(Boolean).join(' — ')
    }
    case 'create_task':
      return String(config.title || config.description || '')
    case 'assign_owner':
      return String(config.role || config.owner || '')
    case 'update_tag':
      return String(config.tag || '')
    case 'log_note':
      return String(config.note || config.content || '')
    case 'schedule_review':
      return config.delay_days ? `dans ${config.delay_days} jours` : ''
    case 'send_email':
      return String(config.email_subject || '')
    case 'send_email_hubspot':
      return String(config.subject || config.email_subject || '')
    default:
      return ''
  }
}

/**
 * Convertit les actions d'un playbook en format d'affichage avec labels.
 */
export function buildActionsDisplay(
  actions: PlaybookAction[] | null | undefined,
): ActionDisplay[] {
  if (!actions || !Array.isArray(actions)) return []

  return actions
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((action) => ({
      step: action.order,
      type: action.type,
      label: ACTION_TYPE_LABELS[action.type] || action.type,
      detail: buildActionDetail(action),
    }))
}

// ── Execution stats ──────────────────────────────────────────

/**
 * Calcule les statistiques d'exécution à partir d'une liste d'exécutions.
 */
export function computeExecutionStats(
  executions: ExecutionStatsInput[],
): ExecutionStats {
  const uniqueAccounts = new Set<string>()
  const reachedAccounts = new Set<string>()
  const convertedAccounts = new Set<string>()

  let mrrRecovered = 0
  let mrrExpansion = 0
  let total = 0
  let completed = 0
  let failed = 0
  let inProgress = 0

  for (const exec of executions) {
    total++
    uniqueAccounts.add(exec.account_id)

    if (exec.execution_status === 'completed' || exec.execution_status === 'running' || exec.execution_status === 'partially_completed') {
      reachedAccounts.add(exec.account_id)
    }

    if (exec.execution_status === 'completed') {
      completed++
    } else if (exec.execution_status === 'failed') {
      failed++
    } else if (exec.execution_status === 'running' || exec.execution_status === 'pending') {
      inProgress++
    }

    if (exec.account_converted) {
      convertedAccounts.add(exec.account_id)
    }

    mrrRecovered += exec.mrr_recovered_cents ?? 0
    mrrExpansion += exec.mrr_expansion_cents ?? 0
  }

  return {
    targeted_count: uniqueAccounts.size,
    reached_count: reachedAccounts.size,
    converted_count: convertedAccounts.size,
    mrr_recovered_cents: mrrRecovered,
    mrr_expansion_cents: mrrExpansion,
    executions_total: total,
    executions_completed: completed,
    executions_failed: failed,
    executions_in_progress: inProgress,
  }
}

// ── French urgency classification (aligned with RPC) ────────

/**
 * Classifie un compte par urgence avec labels français.
 * Mêmes seuils que classifyUrgency (>=70, >=40, <40) mais labels FR.
 */
export function classifyUrgencyFr(churnRiskScore: number | null): UrgencyLevelFr {
  if (churnRiskScore === null || churnRiskScore === undefined) return 'stable'
  if (churnRiskScore >= 70) return 'urgent'
  if (churnRiskScore >= 40) return 'surveiller'
  return 'stable'
}

/**
 * Construit le résumé des comptes éligibles pour la réponse unifiée.
 */
export function buildEligibleAccountsSummary(
  accounts: EligibleAccountRow[],
): EligibleAccountsSummary {
  const summary: EligibleAccountsSummary = {
    total: accounts.length,
    mrr_at_risk_cents: 0,
    urgent_count: 0,
    surveiller_count: 0,
    stable_count: 0,
  }

  for (const account of accounts) {
    summary.mrr_at_risk_cents += account.mrr_cents ?? 0
    const urgency = account.urgency || classifyUrgencyFr(account.churn_risk_score)
    if (urgency === 'urgent') summary.urgent_count++
    else if (urgency === 'surveiller') summary.surveiller_count++
    else summary.stable_count++
  }

  return summary
}

/**
 * Transforme un compte brut en EligibleAccountRow.
 * Zero-PII : uniquement stripe_customer_id et scores.
 */
export function buildEligibleAccountRow(account: {
  account_id?: string
  id?: string
  stripe_customer_id?: string | null
  mrr_cents?: number | null
  churn_risk_score?: number | null
  health_score?: number | null
  expansion_score?: number | null
  urgency?: string
}): EligibleAccountRow {
  return {
    account_id: (account.account_id || account.id || '') as string,
    stripe_customer_id: account.stripe_customer_id ?? null,
    mrr_cents: account.mrr_cents ?? null,
    churn_risk_score: account.churn_risk_score ?? null,
    health_score: account.health_score ?? null,
    expansion_score: account.expansion_score ?? null,
    urgency: (account.urgency as UrgencyLevelFr) || classifyUrgencyFr(account.churn_risk_score ?? null),
  }
}
