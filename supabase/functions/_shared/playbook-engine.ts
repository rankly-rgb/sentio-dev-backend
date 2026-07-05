// ============================================================
// Playbook Engine — Types & logique métier pure
// Aucune dépendance Supabase (fonctions pures testables)
// ============================================================

// ── Comparison operators ────────────────────────────────────
export type ComparisonOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in'
export type LogicalOperator = 'AND' | 'OR'

export interface Condition {
  field: string
  operator: ComparisonOperator
  value: unknown
}

export interface ConditionGroup {
  operator: LogicalOperator
  conditions: Condition[]
}

// ── Action types ────────────────────────────────────────────
export const VALID_ACTION_TYPES = [
  'send_email',       // V1 : alerte email via Resend (action principale)
  'export_csv',       // V1 : export liste comptes ciblés (transit PII)
  'log_note',         // V1 : journalisation interne
  'flag_for_review',  // V1 : marquage manuel
  /* V2 */ // 'slack_notify',
  /* V2 */ // 'hubspot_enroll_sequence',
  /* V2 */ // 'hubspot_update_company',
  /* V2 */ // 'hubspot_create_task',
  /* V2 */ // 'create_task',
  /* V2 */ // 'assign_owner',
  /* V2 */ // 'update_tag',
  /* V2 */ // 'schedule_review',
] as const

export type PlaybookActionType = typeof VALID_ACTION_TYPES[number]

export interface PlaybookAction {
  type: PlaybookActionType
  config: Record<string, unknown>
  order: number
}

export interface ActionResult {
  action_type: PlaybookActionType
  order: number
  status: 'completed' | 'failed' | 'skipped'
  message: string
  executed_at: string
}

// ── Playbook constants ──────────────────────────────────────
export const VALID_PLAYBOOK_STATUSES = ['draft', 'active', 'paused', 'completed', 'archived'] as const
export type PlaybookStatus = typeof VALID_PLAYBOOK_STATUSES[number]

export const VALID_PLAYBOOK_TYPES = ['manual', 'automated', 'semi_automated', 'template'] as const
export type PlaybookType = typeof VALID_PLAYBOOK_TYPES[number]

export const VALID_TEMPLATE_CATEGORIES = [
  'churn_prevention',
  'expansion',
  'renewal',
  'payment_recovery',
  'reactivation',
  /* V2 */ // 'onboarding',
  /* V2 */ // 'winback',
  /* V2 */ // 'health_monitoring',
  /* V2 */ // 'customer_education',
  /* V2 */ // 'nps_detractors',
  /* V2 */ // 'champions_advocacy',
  /* V2 */ // 'downgrade_prevention',
  /* V2 */ // 'success_planning',
] as const
export type TemplateCategory = typeof VALID_TEMPLATE_CATEGORIES[number]

export const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const
export type PlaybookPriority = typeof VALID_PRIORITIES[number]

export const VALID_EXECUTION_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const
export type ExecutionFrequency = typeof VALID_EXECUTION_FREQUENCIES[number]

export const VALID_COMPARISON_OPERATORS: ComparisonOperator[] = [
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in',
]

// ── Account data (champs de la table accounts pour évaluation) ──
export interface AccountData {
  id: string
  organization_id: string
  stripe_customer_id: string | null
  hubspot_company_id: string | null
  display_name: string | null
  health_score: number | null
  churn_risk_score: number | null
  expansion_score: number | null
  product_usage_score: number | null
  mrr_cents: number | null
  arr_cents: number | null
  plan_tier: string | null
  seat_count: number | null
  seat_limit: number | null
  contract_start_date: string | null
  contract_end_date: string | null
  created_at: string
}

// ── Condition evaluation ────────────────────────────────────

/**
 * Évalue une condition unique contre les données d'un compte.
 * Retourne false si le champ n'existe pas sur le compte.
 */
export function evaluateCondition(
  condition: Condition,
  accountData: Record<string, unknown>,
): boolean {
  const actualValue = accountData[condition.field]

  // Champ absent ou null → condition non satisfaite
  if (actualValue === undefined || actualValue === null) {
    return false
  }

  switch (condition.operator) {
    case 'eq':
      return actualValue === condition.value

    case 'neq':
      return actualValue !== condition.value

    case 'gt': {
      const num = Number(actualValue)
      const threshold = Number(condition.value)
      if (isNaN(num) || isNaN(threshold)) return false
      return num > threshold
    }

    case 'gte': {
      const num = Number(actualValue)
      const threshold = Number(condition.value)
      if (isNaN(num) || isNaN(threshold)) return false
      return num >= threshold
    }

    case 'lt': {
      const num = Number(actualValue)
      const threshold = Number(condition.value)
      if (isNaN(num) || isNaN(threshold)) return false
      return num < threshold
    }

    case 'lte': {
      const num = Number(actualValue)
      const threshold = Number(condition.value)
      if (isNaN(num) || isNaN(threshold)) return false
      return num <= threshold
    }

    case 'in': {
      if (!Array.isArray(condition.value)) return false
      return condition.value.includes(actualValue)
    }

    case 'not_in': {
      if (!Array.isArray(condition.value)) return false
      return !condition.value.includes(actualValue)
    }

    default:
      return false
  }
}

/**
 * Évalue un groupe de conditions (AND/OR) contre les données d'un compte.
 * Retourne true si le groupe est null/undefined ou si conditions est vide.
 */
export function evaluateConditions(
  conditionGroup: ConditionGroup | null | undefined,
  accountData: Record<string, unknown>,
): boolean {
  if (!conditionGroup) return true
  if (!conditionGroup.conditions || conditionGroup.conditions.length === 0) return true

  if (conditionGroup.operator === 'OR') {
    return conditionGroup.conditions.some((c) => evaluateCondition(c, accountData))
  }

  // AND par défaut
  return conditionGroup.conditions.every((c) => evaluateCondition(c, accountData))
}

// ── Validation ──────────────────────────────────────────────

/**
 * Valide le JSONB `actions` d'un playbook.
 * Retourne le tableau typé ou throw une erreur descriptive.
 */
export function validatePlaybookActions(actions: unknown): PlaybookAction[] {
  if (!Array.isArray(actions)) {
    throw new Error('actions must be a non-empty array')
  }
  if (actions.length === 0) {
    throw new Error('actions must be a non-empty array')
  }

  const seenOrders = new Set<number>()
  const validated: PlaybookAction[] = []

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]

    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      throw new Error(`actions[${i}] must be an object`)
    }

    const { type, config, order } = action as Record<string, unknown>

    // Validate type
    if (!type || typeof type !== 'string' || !(VALID_ACTION_TYPES as readonly string[]).includes(type)) {
      throw new Error(
        `actions[${i}].type must be one of: ${VALID_ACTION_TYPES.join(', ')}`,
      )
    }

    // Validate config
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`actions[${i}].config must be an object`)
    }

    // Type-specific config validation
    if (type === 'send_email') {
      const cfg = config as Record<string, unknown>
      const subject = cfg.email_subject
      const body = cfg.email_body_html
      if (!subject || typeof subject !== 'string' || subject.trim().length === 0) {
        throw new Error(`actions[${i}].config.email_subject must be a non-empty string`)
      }
      if (subject.length > 150) {
        throw new Error(`actions[${i}].config.email_subject must be 150 characters or less`)
      }
      if (!body || typeof body !== 'string' || body.trim().length === 0) {
        throw new Error(`actions[${i}].config.email_body_html must be a non-empty string`)
      }
      if (body.length < 10) {
        throw new Error(`actions[${i}].config.email_body_html must be at least 10 characters`)
      }
    }

    // Validate order
    if (typeof order !== 'number' || !Number.isInteger(order) || order < 1) {
      throw new Error(`actions[${i}].order must be a positive integer`)
    }

    if (seenOrders.has(order)) {
      throw new Error(`actions[${i}].order ${order} is duplicated`)
    }
    seenOrders.add(order)

    validated.push({
      type: type as PlaybookActionType,
      config: config as Record<string, unknown>,
      order: order as number,
    })
  }

  return validated
}

/**
 * Valide le JSONB `trigger_conditions` ou `eligibility_criteria`.
 * Retourne null si l'input est null/undefined.
 * Throw une erreur descriptive si invalide.
 */
export function validateConditions(conditions: unknown): ConditionGroup | null {
  if (conditions === null || conditions === undefined) return null

  if (typeof conditions !== 'object' || Array.isArray(conditions)) {
    throw new Error('conditions must be an object with operator and conditions')
  }

  const obj = conditions as Record<string, unknown>

  if (!obj.operator || (obj.operator !== 'AND' && obj.operator !== 'OR')) {
    throw new Error('conditions.operator must be "AND" or "OR"')
  }

  if (!Array.isArray(obj.conditions)) {
    throw new Error('conditions.conditions must be an array')
  }

  for (let i = 0; i < obj.conditions.length; i++) {
    const cond = obj.conditions[i] as Record<string, unknown>

    if (!cond || typeof cond !== 'object' || Array.isArray(cond)) {
      throw new Error(`conditions.conditions[${i}] must be an object`)
    }

    if (!cond.field || typeof cond.field !== 'string') {
      throw new Error(`conditions.conditions[${i}].field must be a non-empty string`)
    }

    if (!cond.operator || typeof cond.operator !== 'string' ||
        !VALID_COMPARISON_OPERATORS.includes(cond.operator as ComparisonOperator)) {
      throw new Error(
        `conditions.conditions[${i}].operator must be one of: ${VALID_COMPARISON_OPERATORS.join(', ')}`,
      )
    }

    if (cond.value === undefined) {
      throw new Error(`conditions.conditions[${i}].value is required`)
    }
  }

  return {
    operator: obj.operator as LogicalOperator,
    conditions: obj.conditions.map((c: Record<string, unknown>) => ({
      field: c.field as string,
      operator: c.operator as ComparisonOperator,
      value: c.value,
    })),
  }
}

// ── Action execution (V1 : log only, pas de dispatch externe) ──

/**
 * Exécute une action V1 : log l'action sans dispatch externe.
 * Retourne toujours 'completed' avec un message descriptif.
 */
export function executeAction(
  action: PlaybookAction,
  account: AccountData,
  context: { playbookId: string; executionId: string },
): ActionResult {
  const message = `Action logged: ${action.type} for account ${account.id} ` +
    `(playbook=${context.playbookId}, execution=${context.executionId}, ` +
    `config=${JSON.stringify(action.config)})`

  return {
    action_type: action.type,
    order: action.order,
    status: 'completed',
    message,
    executed_at: new Date().toISOString(),
  }
}

// ── Scheduling ──────────────────────────────────────────────

/**
 * Calcule la prochaine date d'exécution planifiée.
 * daily = +24h, weekly = +7j, monthly = +30j
 */
export function calculateNextScheduledAt(
  frequency: ExecutionFrequency,
  fromDate?: Date,
): string {
  const base = fromDate ?? new Date()
  const next = new Date(base.getTime())

  switch (frequency) {
    case 'daily':
      next.setTime(next.getTime() + 24 * 60 * 60 * 1000)
      break
    case 'weekly':
      next.setTime(next.getTime() + 7 * 24 * 60 * 60 * 1000)
      break
    case 'monthly':
      next.setTime(next.getTime() + 30 * 24 * 60 * 60 * 1000)
      break
  }

  return next.toISOString()
}

/**
 * Vérifie si une exécution récente existe dans la fenêtre de cooldown.
 * Retourne true si lastExecutedAt est dans les cooldownHours dernières heures.
 */
export function isRecentExecution(
  lastExecutedAt: string | null,
  cooldownHours: number,
): boolean {
  if (!lastExecutedAt) return false
  const lastTime = new Date(lastExecutedAt).getTime()
  const cutoff = Date.now() - cooldownHours * 60 * 60 * 1000
  return lastTime > cutoff
}

// ── Workflow Steps ──────────────────────────────────────────

export interface WorkflowStep {
  step_order: number
  delay_days: number
  action_type: PlaybookActionType
  title: string
  config: Record<string, unknown>
}

/**
 * Valide le JSONB `steps` d'un workflow.
 * Retourne le tableau typé ou throw une erreur descriptive.
 */
export function validateWorkflowSteps(steps: unknown): WorkflowStep[] {
  if (!Array.isArray(steps)) {
    throw new Error('steps must be a non-empty array')
  }
  if (steps.length === 0) {
    throw new Error('steps must be a non-empty array')
  }

  const seenOrders = new Set<number>()
  const validated: WorkflowStep[] = []

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]

    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error('steps[' + i + '] must be an object')
    }

    const { step_order, delay_days, action_type, title, config } = step as Record<string, unknown>

    // Validate step_order
    if (typeof step_order !== 'number' || !Number.isInteger(step_order) || step_order < 1) {
      throw new Error('steps[' + i + '].step_order must be a positive integer')
    }

    if (seenOrders.has(step_order)) {
      throw new Error('steps[' + i + '].step_order ' + step_order + ' is duplicated')
    }
    seenOrders.add(step_order)

    // Validate delay_days
    if (typeof delay_days !== 'number' || delay_days < 0) {
      throw new Error('steps[' + i + '].delay_days must be a non-negative number')
    }

    // Validate action_type
    if (!action_type || typeof action_type !== 'string' ||
        !(VALID_ACTION_TYPES as readonly string[]).includes(action_type)) {
      throw new Error(
        'steps[' + i + '].action_type must be one of: ' + VALID_ACTION_TYPES.join(', '),
      )
    }

    // Validate title
    if (!title || typeof title !== 'string') {
      throw new Error('steps[' + i + '].title must be a non-empty string')
    }

    // Validate config
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('steps[' + i + '].config must be an object')
    }

    // For send_email, validate required config fields
    if (action_type === 'send_email') {
      if (!config.email_subject || typeof config.email_subject !== 'string') {
        throw new Error('steps[' + i + '].config.email_subject is required for send_email')
      }
      if (!config.email_body_html || typeof config.email_body_html !== 'string') {
        throw new Error('steps[' + i + '].config.email_body_html is required for send_email')
      }
    }

    validated.push({
      step_order: step_order as number,
      delay_days: delay_days as number,
      action_type: action_type as PlaybookActionType,
      title: title as string,
      config: config as Record<string, unknown>,
    })
  }

  return validated
}

/**
 * Calcule la date du prochain step basée sur delay_days depuis une date de référence.
 */
export function calculateStepDueDate(delayDays: number, fromDate?: Date): string {
  const base = fromDate || new Date()
  const due = new Date(base.getTime() + delayDays * 24 * 60 * 60 * 1000)
  return due.toISOString()
}

// ── Playbook Templates V1 ───────────────────────────────────

export interface PlaybookTemplate {
  id: string
  title_fr: string
  title_en: string
  description_fr: string
  description_en: string
  playbook_type: PlaybookType
  template_category: string
  priority: 'critical' | 'high' | 'medium' | 'low'
  is_automated: boolean
  trigger_conditions: Record<string, unknown>
  eligibility_criteria?: Record<string, unknown>
  actions: PlaybookAction[]
}

export const PLAYBOOK_TEMPLATES_V1: PlaybookTemplate[] = [
  {
    id: 'churn-critical-alert',
    title_fr: 'Alerte churn critique',
    title_en: 'Critical churn alert',
    description_fr: 'Envoie une alerte email immédiate quand un compte passe sous le seuil de risque critique (score < 40).',
    description_en: 'Sends an immediate email alert when an account drops below the critical risk threshold (score < 40).',
    playbook_type: 'automated',
    template_category: 'churn_prevention',
    priority: 'critical',
    is_automated: true,
    trigger_conditions: { health_score_below: 40, evaluation: 'daily' },
    eligibility_criteria: { mrr_cents_min: 1 },
    actions: [{
      type: 'send_email',
      order: 1,
      config: {
        email_subject: '🚨 Risque critique — {{account_name}} (score {{health_score}})',
        email_body_html: '<p><strong>{{account_name}}</strong> a atteint un score de santé critique de <strong>{{health_score}}/100</strong>.</p><p>MRR : {{mrr}} | Risque de churn : {{churn_risk}}%</p><p>Action recommandée : contacter ce compte dans les 48h.</p>',
      },
    }],
  },
  {
    id: 'churn-progressive-decline',
    title_fr: 'Déclin progressif détecté',
    title_en: 'Progressive decline detected',
    description_fr: 'Alerte quand le score de santé d\'un compte baisse de plus de 15 points en 30 jours.',
    description_en: 'Alerts when an account health score drops more than 15 points in 30 days.',
    playbook_type: 'automated',
    template_category: 'churn_prevention',
    priority: 'high',
    is_automated: true,
    trigger_conditions: { health_score_drop_30d: 15, evaluation: 'daily' },
    actions: [{
      type: 'send_email',
      order: 1,
      config: {
        email_subject: '📉 Déclin détecté — {{account_name}} (-{{score_drop}} pts en 30j)',
        email_body_html: '<p>Le score de <strong>{{account_name}}</strong> a baissé de <strong>{{score_drop}} points</strong> sur les 30 derniers jours.</p><p>Score actuel : {{health_score}}/100</p>',
      },
    }],
  },
  {
    id: 'renewal-upcoming',
    title_fr: 'Renouvellement imminent',
    title_en: 'Upcoming renewal',
    description_fr: 'Alerte 30 jours avant la date de renouvellement d\'un abonnement.',
    description_en: 'Alerts 30 days before a subscription renewal date.',
    playbook_type: 'automated',
    template_category: 'renewal',
    priority: 'medium',
    is_automated: true,
    trigger_conditions: { days_until_renewal: 30, evaluation: 'daily' },
    actions: [{
      type: 'send_email',
      order: 1,
      config: {
        email_subject: '📅 Renouvellement dans 30j — {{account_name}}',
        email_body_html: '<p>Le contrat de <strong>{{account_name}}</strong> arrive à renouvellement dans <strong>30 jours</strong>.</p><p>MRR actuel : {{mrr}} | Score de santé : {{health_score}}/100</p>',
      },
    }],
  },
  {
    id: 'payment-recovery',
    title_fr: 'Paiement en échec',
    title_en: 'Failed payment',
    description_fr: 'Alerte immédiate quand un compte passe en statut past_due ou unpaid dans Stripe.',
    description_en: 'Immediate alert when an account becomes past_due or unpaid in Stripe.',
    playbook_type: 'automated',
    template_category: 'payment_recovery',
    priority: 'critical',
    is_automated: true,
    trigger_conditions: { stripe_status: ['past_due', 'unpaid'], evaluation: 'on_sync' },
    actions: [
      {
        type: 'send_email',
        order: 1,
        config: {
          email_subject: '💳 Paiement en échec — {{account_name}}',
          email_body_html: '<p>Le compte <strong>{{account_name}}</strong> est en statut <strong>{{stripe_status}}</strong>.</p><p>MRR concerné : {{mrr}}</p>',
        },
      },
      {
        type: 'export_csv',
        order: 2,
        config: {},
      },
    ],
  },
  {
    id: 'expansion-opportunity',
    title_fr: 'Opportunité d\'expansion',
    title_en: 'Expansion opportunity',
    description_fr: 'Identifie les comptes avec un score de santé élevé et une croissance MRR sur 2 mois.',
    description_en: 'Identifies accounts with a high health score and MRR growth over 2 months.',
    playbook_type: 'manual',
    template_category: 'expansion',
    priority: 'medium',
    is_automated: false,
    trigger_conditions: { health_score_above: 75, mrr_growth_2m: true, evaluation: 'weekly' },
    actions: [{
      type: 'export_csv',
      order: 1,
      config: {},
    }],
  },
  {
    id: 'reactivation-churned',
    title_fr: 'Comptes à réactiver',
    title_en: 'Accounts to reactivate',
    description_fr: 'Liste les comptes churned depuis moins de 90 jours, candidats à une réactivation.',
    description_en: 'Lists accounts churned within the last 90 days, candidates for reactivation.',
    playbook_type: 'manual',
    template_category: 'reactivation',
    priority: 'low',
    is_automated: false,
    trigger_conditions: { churned_within_days: 90, evaluation: 'weekly' },
    actions: [{
      type: 'export_csv',
      order: 1,
      config: {},
    }],
  },
]
