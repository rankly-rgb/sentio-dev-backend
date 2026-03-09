// ============================================================
// Playbook seed helpers — Pure functions for default playbook templates
// No Deno/jsr imports — testable with Vitest
// ============================================================

export interface PlaybookTemplate {
  title: string
  description: string
  playbook_type: 'manual' | 'automated' | 'semi_automated'
  template_category: string
  actions: ActionStep[]
  eligibility_criteria: EligibilityCriteria
  status: 'draft'
  priority: 'critical' | 'high' | 'medium' | 'low'
  source: 'system'
  is_automated: boolean
  is_template: true
}

export interface ActionStep {
  type: string
  order: number
  config: Record<string, unknown>
}

export interface EligibilityCriteria {
  operator: 'AND' | 'OR'
  conditions: Condition[]
}

export interface Condition {
  field: string
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in'
  value: unknown
}

/**
 * Returns the 9 default playbook templates.
 * Pure function — no side effects, no DB calls.
 */
export function getDefaultPlaybookTemplates(): PlaybookTemplate[] {
  return [
    {
      title: 'Prévention churn — Comptes enterprise',
      description: 'Playbook de rétention ciblant les comptes enterprise à haut risque de churn. Déclenche une alerte Slack, crée une tâche de suivi et marque le compte pour revue.',
      playbook_type: 'semi_automated',
      template_category: 'churn_prevention',
      actions: [
        { type: 'slack_notify', order: 1, config: { channel: '#cs-critical', template: 'churn_alert_enterprise' } },
        { type: 'create_task', order: 2, config: { title: 'Appel de rétention urgent', due_days: 2 } },
        { type: 'assign_owner', order: 3, config: { role: 'csm_senior' } },
        { type: 'flag_for_review', order: 4, config: {} },
      ],
      eligibility_criteria: {
        operator: 'AND',
        conditions: [
          { field: 'churn_risk_score', operator: 'gte', value: 70 },
          { field: 'plan_tier', operator: 'in', value: ['growth', 'enterprise'] },
          { field: 'mrr_cents', operator: 'gte', value: 50000 },
        ],
      },
      status: 'draft',
      priority: 'critical',
      source: 'system',
      is_automated: false,
      is_template: true,
    },
    {
      title: 'Relance comptes inactifs',
      description: 'Cible les comptes avec un score d\'usage faible. Envoie une notification et planifie une session de redécouverte produit.',
      playbook_type: 'automated',
      template_category: 'reactivation',
      actions: [
        { type: 'slack_notify', order: 1, config: { channel: '#cs-team', template: 'inactive_account' } },
        { type: 'create_task', order: 2, config: { title: 'Planifier démo re-onboarding', due_days: 5 } },
        { type: 'log_note', order: 3, config: { note: 'Compte détecté comme inactif — relance automatique déclenchée' } },
      ],
      eligibility_criteria: {
        operator: 'AND',
        conditions: [
          { field: 'product_usage_score', operator: 'lte', value: 20 },
          { field: 'health_score', operator: 'lte', value: 40 },
        ],
      },
      status: 'draft',
      priority: 'high',
      source: 'system',
      is_automated: true,
      is_template: true,
    },
    {
      title: 'Détection opportunité d\'expansion',
      description: 'Identifie les comptes avec une utilisation élevée des sièges et un bon score de santé. Crée une opportunité d\'upsell.',
      playbook_type: 'semi_automated',
      template_category: 'expansion',
      actions: [
        { type: 'slack_notify', order: 1, config: { channel: '#sales-expansion', template: 'expansion_opportunity' } },
        { type: 'create_task', order: 2, config: { title: 'Préparer proposition d\'upgrade', due_days: 7 } },
        { type: 'update_tag', order: 3, config: { tag: 'expansion_candidate' } },
      ],
      eligibility_criteria: {
        operator: 'AND',
        conditions: [
          { field: 'expansion_score', operator: 'gte', value: 70 },
          { field: 'health_score', operator: 'gte', value: 60 },
        ],
      },
      status: 'draft',
      priority: 'medium',
      source: 'system',
      is_automated: false,
      is_template: true,
    },
    {
      title: 'Onboarding nouveaux comptes',
      description: 'Accompagnement des comptes créés depuis moins de 30 jours. Assigne un CSM, planifie un check-in et envoie un welcome Slack.',
      playbook_type: 'automated',
      template_category: 'onboarding',
      actions: [
        { type: 'assign_owner', order: 1, config: { role: 'csm' } },
        { type: 'slack_notify', order: 2, config: { channel: '#cs-onboarding', template: 'new_account_welcome' } },
        { type: 'create_task', order: 3, config: { title: 'Premier check-in onboarding', due_days: 3 } },
        { type: 'schedule_review', order: 4, config: { review_days: 14 } },
      ],
      eligibility_criteria: {
        operator: 'AND',
        conditions: [
          { field: 'health_score', operator: 'lte', value: 50 },
        ],
      },
      status: 'draft',
      priority: 'high',
      source: 'system',
      is_automated: true,
      is_template: true,
    },
    {
      title: 'Suivi renouvellement contrat',
      description: 'Alerte 60 jours avant l\'échéance du contrat. Prépare le dossier de renouvellement et planifie une réunion.',
      playbook_type: 'semi_automated',
      template_category: 'renewal',
      actions: [
        { type: 'slack_notify', order: 1, config: { channel: '#cs-renewals', template: 'renewal_upcoming' } },
        { type: 'create_task', order: 2, config: { title: 'Préparer dossier de renouvellement', due_days: 14 } },
        { type: 'create_task', order: 3, config: { title: 'Planifier réunion de renouvellement', due_days: 7 } },
        { type: 'flag_for_review', order: 4, config: {} },
      ],
      eligibility_criteria: {
        operator: 'AND',
        conditions: [
          { field: 'mrr_cents', operator: 'gte', value: 30000 },
        ],
      },
      status: 'draft',
      priority: 'high',
      source: 'system',
      is_automated: false,
      is_template: true,
    },
    {
      title: 'Récupération comptes perdus',
      description: 'Cible les comptes récemment désabonnés avec un MRR significatif. Déclenche une campagne de winback.',
      playbook_type: 'manual',
      template_category: 'winback',
      actions: [
        { type: 'slack_notify', order: 1, config: { channel: '#cs-winback', template: 'winback_campaign' } },
        { type: 'assign_owner', order: 2, config: { role: 'account_executive' } },
        { type: 'create_task', order: 3, config: { title: 'Appel winback — proposer offre spéciale', due_days: 3 } },
        { type: 'log_note', order: 4, config: { note: 'Compte en churn — campagne de récupération déclenchée' } },
      ],
      eligibility_criteria: {
        operator: 'AND',
        conditions: [
          { field: 'churn_risk_score', operator: 'gte', value: 90 },
        ],
      },
      status: 'draft',
      priority: 'medium',
      source: 'system',
      is_automated: false,
      is_template: true,
    },
    {
      title: 'Alerte churn risque élevé',
      description: 'Notification automatique quand un compte dépasse 70% de risque de churn. Actif en continu.',
      playbook_type: 'automated',
      template_category: 'churn_prevention',
      actions: [
        { type: 'slack_notify', order: 1, config: { channel: '#cs-alerts', template: 'high_churn_risk' } },
        { type: 'create_task', order: 2, config: { title: 'Intervention urgente — risque de churn', due_days: 1 } },
        { type: 'flag_for_review', order: 3, config: {} },
      ],
      eligibility_criteria: {
        operator: 'AND',
        conditions: [
          { field: 'churn_risk_score', operator: 'gte', value: 70 },
        ],
      },
      status: 'draft',
      priority: 'critical',
      source: 'system',
      is_automated: true,
      is_template: true,
    },
    {
      title: 'Suivi santé comptes growth',
      description: 'Revue hebdomadaire des comptes growth avec un health score en baisse.',
      playbook_type: 'semi_automated',
      template_category: 'churn_prevention',
      actions: [
        { type: 'slack_notify', order: 1, config: { channel: '#cs-team', template: 'health_drop_alert' } },
        { type: 'create_task', order: 2, config: { title: 'Revue santé compte — analyser causes', due_days: 3 } },
        { type: 'schedule_review', order: 3, config: { review_days: 7 } },
      ],
      eligibility_criteria: {
        operator: 'AND',
        conditions: [
          { field: 'health_score', operator: 'lte', value: 50 },
          { field: 'plan_tier', operator: 'eq', value: 'growth' },
        ],
      },
      status: 'draft',
      priority: 'high',
      source: 'system',
      is_automated: true,
      is_template: true,
    },
    {
      title: 'Upsell sièges — comptes saturés',
      description: 'Détecte les comptes utilisant plus de 80% de leurs sièges disponibles.',
      playbook_type: 'manual',
      template_category: 'expansion',
      actions: [
        { type: 'slack_notify', order: 1, config: { channel: '#sales-expansion', template: 'seat_saturation' } },
        { type: 'create_task', order: 2, config: { title: 'Contacter pour upgrade plan sièges', due_days: 5 } },
        { type: 'update_tag', order: 3, config: { tag: 'seat_upgrade_opportunity' } },
      ],
      eligibility_criteria: {
        operator: 'AND',
        conditions: [
          { field: 'expansion_score', operator: 'gte', value: 65 },
          { field: 'health_score', operator: 'gte', value: 55 },
        ],
      },
      status: 'draft',
      priority: 'medium',
      source: 'system',
      is_automated: false,
      is_template: true,
    },
  ]
}

/**
 * Returns templates filtered by category.
 */
export function getTemplatesByCategory(category: string): PlaybookTemplate[] {
  return getDefaultPlaybookTemplates().filter((t) => t.template_category === category)
}

/**
 * Returns all unique template categories.
 */
export function getTemplateCategories(): string[] {
  const categories = getDefaultPlaybookTemplates().map((t) => t.template_category)
  const unique: string[] = []
  for (const c of categories) {
    if (unique.indexOf(c) === -1) unique.push(c)
  }
  return unique
}

/**
 * Validates that all templates have required fields and valid structure.
 */
export function validateTemplates(templates: PlaybookTemplate[]): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i]
    if (!t.title) errors.push(`Template ${i}: missing title`)
    if (!t.actions || t.actions.length === 0) errors.push(`Template ${i} (${t.title}): no actions`)
    if (!t.eligibility_criteria?.conditions?.length) errors.push(`Template ${i} (${t.title}): no eligibility conditions`)

    // Validate action order is sequential
    const orders = t.actions.map((a) => a.order)
    for (let j = 0; j < orders.length; j++) {
      if (orders[j] !== j + 1) {
        errors.push(`Template ${i} (${t.title}): action order not sequential at position ${j}`)
        break
      }
    }
  }
  return { valid: errors.length === 0, errors }
}
