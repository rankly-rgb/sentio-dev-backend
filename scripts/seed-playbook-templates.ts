/**
 * Seed des playbook templates SaaS B2B pour Sentio AI.
 *
 * Usage :
 *   npx tsx scripts/seed-playbook-templates.ts
 *
 * Nécessite :
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - SEED_ORG_ID (ou passe en argument)
 */

import 'dotenv/config'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const ORG_ID = process.env.SEED_ORG_ID || process.argv[2]

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
if (!ORG_ID) {
  console.error('Usage: npx tsx scripts/seed-playbook-templates.ts <organization_id>')
  process.exit(1)
}

interface PlaybookTemplate {
  organization_id: string
  title: string
  description: string
  playbook_type: string
  template_category: string
  priority: string
  is_template: boolean
  is_automated?: boolean
  execution_frequency?: string
  actions: Array<{ type: string; config: Record<string, unknown>; order: number }>
  eligibility_criteria?: {
    operator: string
    conditions: Array<{ field: string; operator: string; value: unknown }>
  }
}

const templates: PlaybookTemplate[] = [
  {
    organization_id: ORG_ID,
    title: 'Prévention churn — Comptes enterprise',
    description:
      'Playbook de rétention ciblant les comptes enterprise à haut risque de churn. Déclenche une alerte Slack, crée une tâche de suivi et marque le compte pour revue.',
    playbook_type: 'semi_automated',
    template_category: 'churn_prevention',
    priority: 'critical',
    is_template: true,
    actions: [
      { type: 'slack_notify', config: { channel: '#cs-critical', template: 'churn_alert_enterprise' }, order: 1 },
      { type: 'create_task', config: { title: 'Appel de rétention urgent', due_days: 2 }, order: 2 },
      { type: 'assign_owner', config: { role: 'csm_senior' }, order: 3 },
      { type: 'flag_for_review', config: {}, order: 4 },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'churn_risk_score', operator: 'gte', value: 70 },
        { field: 'plan_tier', operator: 'in', value: ['growth', 'enterprise'] },
        { field: 'mrr_cents', operator: 'gte', value: 50000 },
      ],
    },
  },
  {
    organization_id: ORG_ID,
    title: 'Relance comptes inactifs',
    description:
      "Cible les comptes avec un score d'usage faible. Envoie une notification et planifie une session de redécouverte produit.",
    playbook_type: 'automated',
    template_category: 'reactivation',
    priority: 'high',
    is_template: true,
    is_automated: true,
    execution_frequency: 'weekly',
    actions: [
      { type: 'slack_notify', config: { channel: '#cs-team', template: 'inactive_account' }, order: 1 },
      { type: 'create_task', config: { title: 'Planifier démo re-onboarding', due_days: 5 }, order: 2 },
      { type: 'log_note', config: { note: 'Compte détecté comme inactif — relance automatique déclenchée' }, order: 3 },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'product_usage_score', operator: 'lte', value: 20 },
        { field: 'health_score', operator: 'lte', value: 40 },
      ],
    },
  },
  {
    organization_id: ORG_ID,
    title: "Détection opportunité d'expansion",
    description:
      "Identifie les comptes avec une utilisation élevée des sièges et un bon score de santé. Crée une opportunité d'upsell.",
    playbook_type: 'semi_automated',
    template_category: 'expansion',
    priority: 'medium',
    is_template: true,
    actions: [
      { type: 'slack_notify', config: { channel: '#sales-expansion', template: 'expansion_opportunity' }, order: 1 },
      { type: 'create_task', config: { title: "Préparer proposition d'upgrade", due_days: 7 }, order: 2 },
      { type: 'update_tag', config: { tag: 'expansion_candidate' }, order: 3 },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'expansion_score', operator: 'gte', value: 70 },
        { field: 'health_score', operator: 'gte', value: 60 },
      ],
    },
  },
  {
    organization_id: ORG_ID,
    title: 'Onboarding nouveaux comptes',
    description:
      'Accompagnement des comptes créés depuis moins de 30 jours. Assigne un CSM, planifie un check-in et envoie un welcome Slack.',
    playbook_type: 'automated',
    template_category: 'onboarding',
    priority: 'high',
    is_template: true,
    is_automated: true,
    execution_frequency: 'daily',
    actions: [
      { type: 'assign_owner', config: { role: 'csm' }, order: 1 },
      { type: 'slack_notify', config: { channel: '#cs-onboarding', template: 'new_account_welcome' }, order: 2 },
      { type: 'create_task', config: { title: 'Premier check-in onboarding', due_days: 3 }, order: 3 },
      { type: 'schedule_review', config: { review_days: 14 }, order: 4 },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [{ field: 'health_score', operator: 'lte', value: 50 }],
    },
  },
  {
    organization_id: ORG_ID,
    title: 'Suivi renouvellement contrat',
    description:
      "Alerte 60 jours avant l'échéance du contrat. Prépare le dossier de renouvellement et planifie une réunion.",
    playbook_type: 'semi_automated',
    template_category: 'renewal',
    priority: 'high',
    is_template: true,
    actions: [
      { type: 'slack_notify', config: { channel: '#cs-renewals', template: 'renewal_upcoming' }, order: 1 },
      { type: 'create_task', config: { title: 'Préparer dossier de renouvellement', due_days: 14 }, order: 2 },
      { type: 'create_task', config: { title: 'Planifier réunion de renouvellement', due_days: 7 }, order: 3 },
      { type: 'flag_for_review', config: {}, order: 4 },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [{ field: 'mrr_cents', operator: 'gte', value: 30000 }],
    },
  },
  {
    organization_id: ORG_ID,
    title: 'Récupération comptes perdus',
    description:
      'Cible les comptes récemment désabonnés avec un MRR significatif. Déclenche une campagne de winback.',
    playbook_type: 'manual',
    template_category: 'winback',
    priority: 'medium',
    is_template: true,
    actions: [
      { type: 'slack_notify', config: { channel: '#cs-winback', template: 'winback_campaign' }, order: 1 },
      { type: 'assign_owner', config: { role: 'account_executive' }, order: 2 },
      { type: 'create_task', config: { title: 'Appel winback — proposer offre spéciale', due_days: 3 }, order: 3 },
      { type: 'log_note', config: { note: 'Compte en churn — campagne de récupération déclenchée' }, order: 4 },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [{ field: 'churn_risk_score', operator: 'gte', value: 90 }],
    },
  },
]

async function main() {
  console.log(`Seeding ${templates.length} playbook templates for org ${ORG_ID}...`)

  for (const template of templates) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/playbook-crud`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(template),
    })

    if (res.ok) {
      const data = await res.json()
      console.log(`  ✓ ${data.title}`)
    } else {
      const err = await res.text()
      console.error(`  ✗ ${template.title}: ${res.status} ${err}`)
    }
  }

  console.log('Done!')
}

main().catch(console.error)
