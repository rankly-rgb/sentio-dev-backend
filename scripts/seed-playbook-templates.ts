/**
 * Seed des 15 playbook workflow templates anti-churn pour Sentio AI.
 *
 * Usage :
 *   npx tsx scripts/seed-playbook-templates.ts <organization_id>
 *
 * Archive les anciens templates puis insere 15 nouveaux workflows.
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

// Helper : wrap email content in consistent layout
function emailHtml(body: string): string {
  return '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1e293b;">' + body + '<p style="margin-top:24px;color:#64748b;font-size:13px;">— Sentio AI | {{org.name}}</p></div>'
}

interface WorkflowTemplate {
  organization_id: string
  title: string
  title_en: string
  description: string
  description_en: string
  playbook_type: string
  template_category: string
  priority: string
  is_template: boolean
  is_workflow: boolean
  status: string
  actions: unknown[]
  steps: Array<{
    step_order: number
    delay_days: number
    action_type: string
    title: string
    config: Record<string, unknown>
  }>
  eligibility_criteria: {
    operator: string
    conditions: Array<{ field: string; operator: string; value: unknown }>
  }
}

const templates: WorkflowTemplate[] = [
  // ── 1. ALERTE CHURN CRITIQUE ──────────────────────────────
  {
    organization_id: ORG_ID,
    title: 'Alerte Churn Critique',
    title_en: 'Critical Churn Alert',
    description: 'Escalade immediate pour sauvetage de comptes en danger critique. 4 etapes sur 10 jours.',
    description_en: 'Immediate escalation to save accounts in critical danger. 4 steps over 10 days.',
    playbook_type: 'semi_automated',
    template_category: 'churn_prevention',
    priority: 'critical',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'J+0 : Email CSM — Point de situation urgent',
        config: {
          email_subject: '[URGENT] Risque churn critique — Compte {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Alerte Churn Critique</h2><p>Bonjour {{csm.name}},</p><p>Le compte <strong>{{account.id}}</strong> presente des signaux de churn critique :</p><ul><li>Health Score : <strong>{{account.health_score}}/100</strong></li><li>Churn Risk : <strong>{{account.churn_risk_score}}/100</strong></li><li>MRR : <strong>{{account.mrr_eur}} EUR/mois</strong></li><li>Plan : {{account.plan_tier}}</li></ul><p>Action requise : contacter le client sous 24h pour comprendre la situation et proposer un plan de retention.</p><p style="margin-top:16px;"><a href="#" style="background:#dc2626;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;">Voir le compte dans Sentio</a></p>'),
          email_from_name: 'Sentio AI Alertes',
        },
      },
      {
        step_order: 2, delay_days: 2, action_type: 'send_email',
        title: 'J+2 : Relance — Pas de reponse',
        config: {
          email_subject: '[RELANCE] Churn critique — Compte {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Relance — Aucune action detectee</h2><p>{{csm.name}},</p><p>Le compte {{account.id}} est toujours en danger critique (Health: {{account.health_score}}, Churn Risk: {{account.churn_risk_score}}).</p><p>Aucune action n\'a ete enregistree depuis l\'alerte initiale. Merci de :</p><ol><li>Contacter le client par telephone</li><li>Proposer un Health Check gratuit</li><li>Mettre a jour le statut dans Sentio</li></ol>'),
          email_from_name: 'Sentio AI Alertes',
        },
      },
      {
        step_order: 3, delay_days: 5, action_type: 'send_email',
        title: 'J+5 : Escalade VP Customer Success',
        config: {
          email_subject: '[ESCALADE VP] Compte critique — {{account.id}} ({{account.mrr_eur}} EUR MRR)',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Escalade VP — Compte stratégique en danger</h2><p>Ce compte necessite une intervention executive :</p><table style="width:100%;border-collapse:collapse;margin:16px 0;"><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Health Score</td><td style="padding:8px;">{{account.health_score}}/100</td></tr><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Churn Risk</td><td style="padding:8px;">{{account.churn_risk_score}}/100</td></tr><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">MRR</td><td style="padding:8px;">{{account.mrr_eur}} EUR</td></tr><tr><td style="padding:8px;font-weight:bold;">Plan</td><td style="padding:8px;">{{account.plan_tier}}</td></tr></table><p>Proposer : session de formation personnalisee offerte + Health Check avec expert produit.</p>'),
          email_from_name: 'Sentio AI — VP CS',
        },
      },
      {
        step_order: 4, delay_days: 10, action_type: 'send_email',
        title: 'J+10 : Derniere intervention',
        config: {
          email_subject: '[DERNIERE CHANCE] Plan de sauvetage — {{account.id}}',
          email_body_html: emailHtml('<h2>Derniere intervention — Plan de sauvetage</h2><p>{{csm.name}},</p><p>Le compte {{account.id}} ({{account.mrr_eur}} EUR MRR) n\'a pas ete sauve malgre les relances.</p><p><strong>Options finales :</strong></p><ul><li>Appel CEO si compte > 10K EUR MRR</li><li>Proposition de plan de sauvetage sur-mesure</li><li>Option de pause de facturation (1 mois)</li></ul><p>Merci de documenter le resultat final dans Sentio.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'OR',
      conditions: [
        { field: 'churn_risk_score', operator: 'gte', value: 80 },
        { field: 'health_score', operator: 'lte', value: 25 },
      ],
    },
  },

  // ── 2. ONBOARDING ACCELERE ────────────────────────────────
  {
    organization_id: ORG_ID,
    title: 'Onboarding Accelere',
    title_en: 'Fast-track Onboarding',
    description: 'Accompagnement des nouveaux comptes (< 90 jours) pour atteindre le First Value en 14 jours. 6 etapes sur 60 jours.',
    description_en: 'Guides new accounts (< 90 days) to First Value within 14 days. 6 steps over 60 days.',
    playbook_type: 'automated',
    template_category: 'onboarding',
    priority: 'critical',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'J+1 : Email de bienvenue',
        config: {
          email_subject: 'Bienvenue sur {{org.name}} — Votre plan de lancement en 3 etapes',
          email_body_html: emailHtml('<h2 style="color:#4f46e5;">Bienvenue ! 🎉</h2><p>Bonjour,</p><p>Ravi de compter ce nouveau client parmi nos utilisateurs !</p><p>Pour reussir le demarrage, voici les 3 etapes critiques :</p><div style="background:#f8fafc;border-radius:8px;padding:16px;margin:16px 0;"><p>✅ <strong>Etape 1</strong> : Inviter l\'equipe (2 min)</p><p>✅ <strong>Etape 2</strong> : Connecter les donnees Stripe/HubSpot (5 min)</p><p>✅ <strong>Etape 3</strong> : Creer le premier dashboard (3 min)</p></div><p><strong>Objectif : premiers insights dans 48h !</strong></p><p>Le CSM assigne est {{csm.name}} ({{csm.email}}).</p>'),
          email_from_name: 'Sentio AI Onboarding',
        },
      },
      {
        step_order: 2, delay_days: 3, action_type: 'send_email',
        title: 'J+3 : Rappel etapes + tutoriel video',
        config: {
          email_subject: 'Rappel : completez votre setup {{org.name}}',
          email_body_html: emailHtml('<h2>Besoin d\'aide pour demarrer ?</h2><p>{{csm.name}}, le nouveau compte n\'a pas encore complete toutes les etapes d\'onboarding.</p><p>Proposition : envoyer un rappel avec tutoriel video (< 2 min) et proposer une session de setup guidee en visio.</p><p>Score d\'usage actuel : <strong>{{account.product_usage_score}}/100</strong></p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 3, delay_days: 7, action_type: 'send_email',
        title: 'J+7 : Quick Win — Feature la plus utilisee',
        config: {
          email_subject: 'Quick Win : gagnez votre premier insight en 5 minutes',
          email_body_html: emailHtml('<h2>Un Quick Win pour commencer</h2><p>Voici la feature la plus utilisee par les comptes similaires. Proposer un template pre-rempli pour leur cas d\'usage specifique.</p><p>Health Score actuel : <strong>{{account.health_score}}/100</strong></p><p>Usage Score : <strong>{{account.product_usage_score}}/100</strong></p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 14, action_type: 'send_email',
        title: 'J+14 : Check-in CSM personalise',
        config: {
          email_subject: 'Check-in 14 jours — Comment se passe votre utilisation ?',
          email_body_html: emailHtml('<h2>Check-in a 14 jours</h2><p>{{csm.name}}, le compte est actif depuis 14 jours.</p><p><strong>3 questions a poser au client :</strong></p><ol><li>Les donnees sont-elles connectees ?</li><li>Quel est le cas d\'usage prioritaire ?</li><li>Quel resultat metier visez-vous dans 90 jours ?</li></ol><p>Health Score : {{account.health_score}} | Usage : {{account.product_usage_score}}</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 5, delay_days: 30, action_type: 'send_email',
        title: 'J+30 : First Business Review',
        config: {
          email_subject: 'Bilan 30 jours — Premieres metriques de valeur',
          email_body_html: emailHtml('<h2>Bilan du premier mois</h2><p>Proposer un QBR light au client avec les premieres metriques de valeur generees :</p><ul><li>Health Score : <strong>{{account.health_score}}/100</strong></li><li>Usage : <strong>{{account.product_usage_score}}/100</strong></li><li>MRR : <strong>{{account.mrr_eur}} EUR</strong></li></ul><p>Identifier les 3 prochains quick wins.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 6, delay_days: 60, action_type: 'send_email',
        title: 'J+60 : Success Plan 90 jours',
        config: {
          email_subject: 'Success Plan 90 jours — Definissons vos objectifs',
          email_body_html: emailHtml('<h2>Plan de succes a 90 jours</h2><p>Envoyer le template Success Plan pre-rempli avec les donnees du compte :</p><ul><li>Health Score : {{account.health_score}}</li><li>Expansion Score : {{account.expansion_score}}</li><li>Utilisation sieges : {{account.seat_count}}/{{account.seat_limit}}</li></ul><p>Demander la validation des objectifs metier et proposer une roadmap d\'adoption progressive.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'product_usage_score', operator: 'lte', value: 40 },
      ],
    },
  },

  // ── 3. EXPANSION UPSELL SIEGES ────────────────────────────
  {
    organization_id: ORG_ID,
    title: 'Expansion Upsell Sieges',
    title_en: 'Seat Expansion Upsell',
    description: 'Convertir la saturation des sieges en expansion de licences. 4 etapes sur 14 jours.',
    description_en: 'Convert seat saturation into license expansion. 4 steps over 14 days.',
    playbook_type: 'semi_automated',
    template_category: 'expansion',
    priority: 'high',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'J+0 : Email value-based — Sieges satures',
        config: {
          email_subject: 'Opportunite expansion — {{account.seat_usage_pct}}% des sieges utilises',
          email_body_html: emailHtml('<h2 style="color:#4f46e5;">Opportunite d\'expansion detectee</h2><p>{{csm.name}},</p><p>Le compte {{account.id}} utilise <strong>{{account.seat_usage_pct}}%</strong> de ses sieges ({{account.seat_count}}/{{account.seat_limit}}).</p><p><strong>Contexte :</strong></p><ul><li>Health Score : {{account.health_score}}/100 (bon)</li><li>Expansion Score : {{account.expansion_score}}/100</li><li>MRR actuel : {{account.mrr_eur}} EUR</li></ul><p>Proposer un upgrade avec ROI estime base sur les KPIs actuels.</p>'),
          email_from_name: 'Sentio AI Growth',
        },
      },
      {
        step_order: 2, delay_days: 3, action_type: 'send_email',
        title: 'J+3 : Deblocage temporaire propose',
        config: {
          email_subject: '[ACTION] Deblocage temporaire de sieges — {{account.id}}',
          email_body_html: emailHtml('<h2>Proposition de deblocage temporaire</h2><p>Pour eviter de bloquer l\'equipe du client, proposer le deblocage de 5 sieges supplementaires gratuits pour 14 jours.</p><p>Sieges actuels : {{account.seat_count}}/{{account.seat_limit}}</p><p>Cela laisse le temps d\'evaluer les besoins reels.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 3, delay_days: 10, action_type: 'create_task',
        title: 'J+10 : Appel CSM — Comprendre les besoins',
        config: { title: 'Appel expansion — Comprendre besoins de croissance', due_days: 3 },
      },
      {
        step_order: 4, delay_days: 14, action_type: 'send_email',
        title: 'J+14 : Offre speciale VP Sales',
        config: {
          email_subject: 'Offre speciale expansion — {{account.id}}',
          email_body_html: emailHtml('<h2>Offre speciale expansion</h2><p>La periode d\'essai des sieges supplementaires expire. Proposer une offre speciale :</p><ul><li>10% de reduction si upgrade avant J+20</li><li>MRR actuel : {{account.mrr_eur}} EUR</li><li>Expansion Score : {{account.expansion_score}}/100</li></ul>'),
          email_from_name: 'Sentio AI Sales',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'expansion_score', operator: 'gte', value: 75 },
        { field: 'health_score', operator: 'gte', value: 65 },
      ],
    },
  },

  // ── 4. RELANCE COMPTES INACTIFS ───────────────────────────
  {
    organization_id: ORG_ID,
    title: 'Relance Comptes Inactifs',
    title_en: 'Re-engagement of Inactive Accounts',
    description: 'Reactivation des comptes dormants avant que l\'inactivite ne mene au churn. 4 etapes sur 20 jours.',
    description_en: 'Re-activates dormant accounts before inactivity leads to churn. 4 steps over 20 days.',
    playbook_type: 'automated',
    template_category: 'reactivation',
    priority: 'high',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'J+0 : Email "Vous nous manquez"',
        config: {
          email_subject: 'Compte inactif detecte — {{account.id}}',
          email_body_html: emailHtml('<h2>Compte inactif detecte</h2><p>{{csm.name}},</p><p>Aucun login detecte sur le compte {{account.id}} depuis un moment.</p><ul><li>Usage Score : <strong>{{account.product_usage_score}}/100</strong></li><li>Health Score : <strong>{{account.health_score}}/100</strong></li><li>MRR : <strong>{{account.mrr_eur}} EUR</strong></li></ul><p>Contacter le client pour comprendre la situation. Questions cles :</p><ol><li>Difficultés techniques ?</li><li>Le produit ne repond plus aux besoins ?</li><li>Priorite metier a change ?</li></ol>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 2, delay_days: 5, action_type: 'send_email',
        title: 'J+5 : Re-onboarding offert',
        config: {
          email_subject: '[OFFRE] Re-onboarding gratuit — {{account.id}}',
          email_body_html: emailHtml('<h2>Proposition de re-onboarding</h2><p>Sans nouvelle du client, proposer une session gratuite de re-decouverte (45 min) avec un expert produit :</p><ul><li>Revision du cas d\'usage initial</li><li>Decouverte des nouvelles fonctionnalites</li><li>Configuration optimale</li></ul><p>Aucune obligation — juste aider a tirer le maximum de l\'abonnement.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 3, delay_days: 10, action_type: 'send_email',
        title: 'J+10 : Economies manquees',
        config: {
          email_subject: 'Alerte — {{account.mrr_eur}} EUR/mois non utilises',
          email_body_html: emailHtml('<h2 style="color:#f59e0b;">Economies manquees</h2><p>Constat factuel : l\'abonnement coute {{account.mrr_eur}} EUR/mois mais n\'est pas utilise.</p><p><strong>Deux options :</strong></p><ol><li>Reactivation avec aide du CSM (gratuit)</li><li>Pause ou annulation (sans frais)</li></ol><p>Transparence totale — nous sommes la pour aider, pas pour garder contre leur gre.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 20, action_type: 'send_email',
        title: 'J+20 : Offre de downgrade',
        config: {
          email_subject: 'Derniere option avant annulation — {{account.id}}',
          email_body_html: emailHtml('<h2>Derniere option</h2><p>Plutot qu\'une annulation complete, proposer un downgrade :</p><ul><li>Plan inferieur a cout reduit (-60%)</li><li>Acces conserve</li><li>Possibilite de reactiver plus tard</li></ul><p>Ou annulation propre sans frais.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'product_usage_score', operator: 'lte', value: 20 },
        { field: 'health_score', operator: 'lte', value: 40 },
      ],
    },
  },

  // ── 5. RENOUVELLEMENT CONTRAT 90/60/30 ────────────────────
  {
    organization_id: ORG_ID,
    title: 'Renouvellement Contrat 90/60/30',
    title_en: 'Contract Renewal Sequence 90/60/30',
    description: 'Sequence de renouvellement anticipee sur 90 jours pour comptes annuels. 6 etapes.',
    description_en: 'Anticipatory renewal sequence over 90 days for annual contracts. 6 steps.',
    playbook_type: 'semi_automated',
    template_category: 'renewal',
    priority: 'critical',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'J-90 : Premier contact renouvellement',
        config: {
          email_subject: 'Votre renouvellement dans 3 mois — Bilan annuel',
          email_body_html: emailHtml('<h2>Renouvellement dans 90 jours</h2><p>{{csm.name}},</p><p>Le contrat du compte {{account.id}} arrive a echeance.</p><p><strong>Bilan :</strong></p><ul><li>Health Score : {{account.health_score}}/100</li><li>MRR : {{account.mrr_eur}} EUR</li><li>Plan : {{account.plan_tier}}</li></ul><p>Options de renouvellement a proposer :</p><ol><li>Renouvellement automatique (aucune action requise)</li><li>Upgrade vers plan superieur</li><li>Ajustements (discutons-en)</li></ol>'),
          email_from_name: 'Sentio AI Renewals',
        },
      },
      {
        step_order: 2, delay_days: 30, action_type: 'send_email',
        title: 'J-60 : Business Review',
        config: {
          email_subject: 'Point bilan + preparation renouvellement (J-60)',
          email_body_html: emailHtml('<h2>Business Review — J-60</h2><p>Avant le renouvellement, proposer un bilan :</p><ul><li>Resultats obtenus cette annee</li><li>Objectifs pour l\'annee prochaine</li><li>Optimisations possibles</li></ul><p>30 minutes ensemble pour preparer le renouvellement.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 3, delay_days: 60, action_type: 'send_email',
        title: 'J-30 : Rappel + incentive early bird',
        config: {
          email_subject: 'Renouvellement dans 30 jours — Offre early bird',
          email_body_html: emailHtml('<h2 style="color:#4f46e5;">Offre Early Bird</h2><p>Le contrat se renouvelle dans 30 jours.</p><p><strong>Offre speciale si renouvellement anticipe :</strong></p><ul><li>10% de reduction sur l\'annee prochaine</li><li>Feature premium offerte</li><li>Session strategique trimestrielle incluse</li></ul><p>MRR actuel : {{account.mrr_eur}} EUR</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 75, action_type: 'send_email',
        title: 'J-15 : Urgence douce',
        config: {
          email_subject: '[ACTION] Confirmation de renouvellement requise',
          email_body_html: emailHtml('<h2 style="color:#f59e0b;">Action requise — J-15</h2><p>Sans action, l\'acces prendra fin a la date d\'expiration.</p><p>L\'offre -10% expire dans 48h.</p><p>Confirmer le renouvellement en un clic.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 5, delay_days: 83, action_type: 'send_email',
        title: 'J-7 : Alerte technique',
        config: {
          email_subject: 'Acces expire dans 7 jours — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Expiration dans 7 jours</h2><p><strong>Rappel important :</strong></p><ul><li>Acces coupe automatiquement si non renouvele</li><li>Donnees conservees 30 jours puis suppression definitive</li></ul><p>Actions possibles : Renouveler | Exporter les donnees | Discuter</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 6, delay_days: 89, action_type: 'send_email',
        title: 'J-1 : Derniere alerte',
        config: {
          email_subject: 'DERNIER JOUR — Compte expire demain',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Dernier jour</h2><p>L\'acces sera suspendu demain a minuit.</p><p>Renouveler maintenant (2 min) ou contacter le CSM en urgence.</p>'),
          email_from_name: 'Sentio AI Urgence',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'mrr_cents', operator: 'gte', value: 30000 },
      ],
    },
  },

  // ── 6. PREVENTION CHURN ENTERPRISE ────────────────────────
  {
    organization_id: ORG_ID,
    title: 'Prevention Churn Enterprise',
    title_en: 'Enterprise Churn Prevention',
    description: 'Protection ultra-prioritaire des comptes strategiques (ARR > 50K EUR). 5 etapes sur 14 jours.',
    description_en: 'Ultra-priority protection for strategic accounts (ARR > 50K EUR). 5 steps over 14 days.',
    playbook_type: 'semi_automated',
    template_category: 'churn_prevention',
    priority: 'critical',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'slack_notify',
        title: 'J+0 : Triple notification Slack',
        config: { channel: '#cs-critical', template: 'enterprise_churn_alert' },
      },
      {
        step_order: 2, delay_days: 1, action_type: 'send_email',
        title: 'J+1 : Email executif VP → Client',
        config: {
          email_subject: '[COMPTE STRATEGIQUE] Point de situation — {{account.id}} ({{account.arr_eur}} EUR ARR)',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Alerte Compte Strategique</h2><p>En tant que VP Customer Success, intervention personnelle requise.</p><table style="width:100%;border-collapse:collapse;margin:16px 0;"><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">ARR</td><td style="padding:8px;">{{account.arr_eur}} EUR</td></tr><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Health Score</td><td style="padding:8px;">{{account.health_score}}/100</td></tr><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Churn Risk</td><td style="padding:8px;">{{account.churn_risk_score}}/100</td></tr><tr><td style="padding:8px;font-weight:bold;">Plan</td><td style="padding:8px;">{{account.plan_tier}}</td></tr></table><p>Proposer un point strategique avec VP CS + CSM + expert produit.</p>'),
          email_from_name: 'Sentio AI — VP CS',
        },
      },
      {
        step_order: 3, delay_days: 3, action_type: 'create_task',
        title: 'J+3 : Executive Business Review forcee',
        config: { title: 'Preparer EBR compte enterprise — rapport QBR auto-genere', due_days: 3 },
      },
      {
        step_order: 4, delay_days: 7, action_type: 'send_email',
        title: 'J+7 : Escalade CEO',
        config: {
          email_subject: '[CEO] Compte strategique a sauver — {{account.arr_eur}} EUR ARR',
          email_body_html: emailHtml('<h2>Escalade CEO</h2><p>Si le compte depasse 100K EUR ARR, email personnel du CEO au contact client.</p><p>Proposer : Advisory Board client + invitation evenement VIP.</p><p>ARR : {{account.arr_eur}} EUR | Health : {{account.health_score}}</p>'),
          email_from_name: 'Sentio AI — Direction',
        },
      },
      {
        step_order: 5, delay_days: 14, action_type: 'send_email',
        title: 'J+14 : Plan de sauvetage sur-mesure',
        config: {
          email_subject: 'Plan de sauvetage 90 jours — {{account.id}}',
          email_body_html: emailHtml('<h2>Plan de sauvetage co-construit</h2><p>Creation d\'un Success Plan 90 jours dedié :</p><ul><li>Ressource dediee (Technical Account Manager)</li><li>SLA renforces contractuels</li><li>Check-ins hebdomadaires</li></ul><p>Health Score actuel : {{account.health_score}} | Objectif : > 70 dans 90 jours</p>'),
          email_from_name: 'Sentio AI',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'arr_cents', operator: 'gte', value: 5000000 },
        { field: 'health_score', operator: 'lte', value: 60 },
      ],
    },
  },

  // ── 7. ADOPTION PROGRESSIVE FEATURE ───────────────────────
  {
    organization_id: ORG_ID,
    title: 'Adoption Progressive Feature',
    title_en: 'Progressive Feature Adoption',
    description: 'Maximiser l\'adoption des features pour augmenter la stickiness. 4 etapes sur 14 jours.',
    description_en: 'Maximise feature adoption to increase stickiness. 4 steps over 14 days.',
    playbook_type: 'automated',
    template_category: 'customer_education',
    priority: 'medium',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'J+0 : Feature spotlight',
        config: {
          email_subject: 'Feature sous-utilisee detectee — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#4f46e5;">Feature Spotlight</h2><p>{{csm.name}},</p><p>Le compte {{account.id}} n\'utilise pas certaines features payantes :</p><ul><li>Usage Score : {{account.product_usage_score}}/100</li><li>Health Score : {{account.health_score}}/100</li></ul><p>Envoyer un email au client avec les benefices concrets et un lien d\'activation directe.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 2, delay_days: 3, action_type: 'slack_notify',
        title: 'J+3 : Notification in-app',
        config: { channel: '#product-adoption', template: 'feature_adoption_reminder' },
      },
      {
        step_order: 3, delay_days: 7, action_type: 'send_email',
        title: 'J+7 : Success story client similaire',
        config: {
          email_subject: 'Success story — Comment un client similaire a gagne en productivite',
          email_body_html: emailHtml('<h2>Success Story</h2><p>Partager une etude de cas d\'un client similaire qui a active les features sous-utilisees.</p><p>Resultats types : amelioration de X% sur les metrics cles, Y heures economisees/mois.</p><p>Usage actuel du compte : {{account.product_usage_score}}/100</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 14, action_type: 'send_email',
        title: 'J+14 : Demo personnalisee offerte',
        config: {
          email_subject: '[OFFRE] Demo personnalisee avec vos donnees',
          email_body_html: emailHtml('<h2>Derniere proposition</h2><p>Offrir une session de 20 minutes pour :</p><ul><li>Configurer les features avec les donnees reelles du client</li><li>3 cas d\'usage specifiques a leur metier</li><li>Repondre a toutes les questions</li></ul><p>Si pas d\'interet, ne plus relancer sur ce sujet.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'product_usage_score', operator: 'lte', value: 50 },
        { field: 'health_score', operator: 'gte', value: 40 },
      ],
    },
  },

  // ── 8. NPS DETRACTEURS RECOVERY ───────────────────────────
  {
    organization_id: ORG_ID,
    title: 'NPS Detracteurs Recovery',
    title_en: 'NPS Detractors Recovery',
    description: 'Transformer une experience negative en opportunite de fidelisation (Service Recovery Paradox). 5 etapes sur 30 jours.',
    description_en: 'Turn a negative experience into a loyalty opportunity (Service Recovery Paradox). 5 steps over 30 days.',
    playbook_type: 'semi_automated',
    template_category: 'nps_detractors',
    priority: 'critical',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'J+0 : Email CSM < 2h apres NPS',
        config: {
          email_subject: '[URGENT] Detracteur NPS detecte — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Detracteur NPS — Action immediate</h2><p>{{csm.name}},</p><p>Un detracteur NPS a ete detecte sur le compte {{account.id}}.</p><ul><li>Health Score : {{account.health_score}}/100</li><li>Churn Risk : {{account.churn_risk_score}}/100</li></ul><p><strong>Action requise sous 2h :</strong></p><ol><li>Appeler le contact principal</li><li>Comprendre ce qui n\'a pas fonctionne</li><li>Presenter un plan d\'action immediat</li></ol>'),
          email_from_name: 'Sentio AI Alertes',
        },
      },
      {
        step_order: 2, delay_days: 1, action_type: 'send_email',
        title: 'J+1 : Escalade VP si score <= 3',
        config: {
          email_subject: '[ESCALADE VP] Detracteur critique — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Escalade VP Customer Success</h2><p>Le VP CS doit appeler personnellement le client si le score NPS est tres bas.</p><p>Objectifs :</p><ol><li>Comprendre ce qui n\'a pas fonctionne</li><li>Presenter un plan d\'action immediat</li><li>S\'engager personnellement sur la resolution</li></ol>'),
          email_from_name: 'Sentio AI — VP CS',
        },
      },
      {
        step_order: 3, delay_days: 7, action_type: 'send_email',
        title: 'J+7 : Suivi resolution',
        config: {
          email_subject: 'Point sur les actions prises — {{account.id}}',
          email_body_html: emailHtml('<h2>Suivi resolution</h2><p>Point d\'etape sur le plan d\'action :</p><ul><li>Health Score actuel : {{account.health_score}}/100</li><li>Evolution depuis l\'alerte</li></ul><p>Envoyer un sondage rapide (1 question) : "Ces actions repondent-elles a vos attentes ?"</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 14, action_type: 'send_email',
        title: 'J+14 : Re-mesure satisfaction',
        config: {
          email_subject: 'Comment evaluez-vous notre reactivite ? — {{account.id}}',
          email_body_html: emailHtml('<h2>Re-mesure satisfaction</h2><p>Envoyer un nouveau sondage NPS cible.</p><p>Si transformation en Promoteur → email personnalise du VP.</p><p>Health Score : {{account.health_score}} | Churn Risk : {{account.churn_risk_score}}</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 5, delay_days: 30, action_type: 'create_task',
        title: 'J+30 : Review finale NPS',
        config: { title: 'Review NPS finale — Verifier amelioration', due_days: 5 },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'health_score', operator: 'lte', value: 40 },
      ],
    },
  },

  // ── 9. CHAMPIONS ADVOCACY ─────────────────────────────────
  {
    organization_id: ORG_ID,
    title: 'Champions Advocacy',
    title_en: 'Champions Advocacy',
    description: 'Transformer les clients satisfaits en ambassadeurs actifs. 4 etapes sur 14 jours.',
    description_en: 'Transform satisfied customers into active brand ambassadors. 4 steps over 14 days.',
    playbook_type: 'semi_automated',
    template_category: 'champions_advocacy',
    priority: 'medium',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'J+0 : Remerciement + demande temoignage',
        config: {
          email_subject: 'Champion detecte — {{account.id}} (Health {{account.health_score}})',
          email_body_html: emailHtml('<h2 style="color:#10b981;">Champion detecte !</h2><p>{{csm.name}},</p><p>Le compte {{account.id}} est un champion :</p><ul><li>Health Score : <strong>{{account.health_score}}/100</strong></li><li>Expansion Score : <strong>{{account.expansion_score}}/100</strong></li><li>MRR : <strong>{{account.mrr_eur}} EUR</strong></li></ul><p><strong>Actions possibles :</strong></p><ol><li>Demander un avis G2/Capterra/TrustPilot</li><li>Proposer un temoignage video</li><li>Co-creer une etude de cas</li></ol>'),
          email_from_name: 'Sentio AI Growth',
        },
      },
      {
        step_order: 2, delay_days: 3, action_type: 'send_email',
        title: 'J+3 : Invitation Programme Champions',
        config: {
          email_subject: '[INVITATION] Programme Champions 2026 — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#4f46e5;">Programme Champions</h2><p>Inviter le client au Programme Champions :</p><ul><li>Acces anticipe aux nouvelles features (beta privee)</li><li>Influence sur la roadmap produit</li><li>Evenements VIP clients</li><li>Badge "Champion" sur profil</li><li>Reductions sur services premium</li></ul>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 3, delay_days: 7, action_type: 'send_email',
        title: 'J+7 : Success story co-brandee',
        config: {
          email_subject: 'Partager votre success story ? — {{account.id}}',
          email_body_html: emailHtml('<h2>Success Story co-brandee</h2><p>Proposer une etude de cas co-brandee :</p><ul><li>Nous redigeons tout</li><li>Le client valide</li><li>Co-promotion sur les deux sites + reseaux sociaux</li></ul><p>Investissement client : 1 interview de 30 min.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 14, action_type: 'send_email',
        title: 'J+14 : Programme de parrainage',
        config: {
          email_subject: 'Programme parrainage — Parrainez, gagnez',
          email_body_html: emailHtml('<h2>Programme Parrainage</h2><p>Proposer le programme de parrainage :</p><ul><li>Credit par client qualifie parraine</li><li>Filleul : 20% de reduction 1ere annee</li><li>Dashboard de suivi des parrainages</li></ul>'),
          email_from_name: 'Sentio AI',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'health_score', operator: 'gte', value: 75 },
        { field: 'expansion_score', operator: 'gte', value: 60 },
      ],
    },
  },

  // ── 10. MULTI-TOUCH GROWTH NURTURING ──────────────────────
  {
    organization_id: ORG_ID,
    title: 'Multi-touch Growth Nurturing',
    title_en: 'Multi-touch Growth Nurturing',
    description: 'Maximiser retention et expansion avec un modele scalable pour comptes Growth (MRR 2K-10K EUR). 5 etapes sur 90 jours.',
    description_en: 'Maximise retention and expansion with a scalable model for Growth accounts (MRR 2K–10K EUR). 5 steps over 90 days.',
    playbook_type: 'automated',
    template_category: 'expansion',
    priority: 'high',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'J+0 : QBR automatique trimestriel',
        config: {
          email_subject: 'Bilan trimestriel {{org.name}} — {{account.id}}',
          email_body_html: emailHtml('<h2>Bilan Trimestriel</h2><p>{{csm.name}},</p><p>Rapport de performance du trimestre :</p><table style="width:100%;border-collapse:collapse;margin:16px 0;"><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Health Score</td><td style="padding:8px;">{{account.health_score}}/100</td></tr><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">MRR</td><td style="padding:8px;">{{account.mrr_eur}} EUR</td></tr><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Usage</td><td style="padding:8px;">{{account.product_usage_score}}/100</td></tr><tr><td style="padding:8px;font-weight:bold;">Expansion</td><td style="padding:8px;">{{account.expansion_score}}/100</td></tr></table><p>Proposer un point strategique de 30 min ce mois-ci.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 2, delay_days: 7, action_type: 'send_email',
        title: 'J+7 : Invitation webinar educatif',
        config: {
          email_subject: 'Webinar mensuel — Best practices {{org.name}}',
          email_body_html: emailHtml('<h2>Webinar Educatif</h2><p>Informer le CSM du prochain webinar mensuel pour inviter le client.</p><p>Format : 45 minutes + Q&A en direct.</p><p>Replay envoye a tous les inscrits.</p>'),
          email_from_name: 'Sentio AI Education',
        },
      },
      {
        step_order: 3, delay_days: 30, action_type: 'send_email',
        title: 'J+30 : Newsletter best practices',
        config: {
          email_subject: 'Newsletter mensuelle — 3 astuces pour optimiser {{org.name}}',
          email_body_html: emailHtml('<h2>Newsletter Best Practices</h2><p>3 astuces mensuelles pour le client :</p><ol><li>Astuce basee sur l\'usage le plus courant</li><li>Tutoriel video d\'une feature avancee</li><li>Template ou guide telecharger</li></ol><p>Usage actuel : {{account.product_usage_score}}/100</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 60, action_type: 'send_email',
        title: 'J+60 : Email d\'engagement si baisse usage',
        config: {
          email_subject: 'Activite en baisse — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#f59e0b;">Activite en baisse</h2><p>{{csm.name}},</p><p>Usage en baisse sur le compte {{account.id}} :</p><ul><li>Usage Score : {{account.product_usage_score}}/100</li><li>Health Score : {{account.health_score}}/100</li></ul><p>Quick win a proposer ou aide necessaire ?</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 5, delay_days: 90, action_type: 'create_task',
        title: 'J+90 : Bilan trimestriel complet',
        config: { title: 'Bilan trimestriel Growth — Preparer rapport + next actions', due_days: 7 },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'mrr_cents', operator: 'gte', value: 200000 },
        { field: 'mrr_cents', operator: 'lte', value: 1000000 },
      ],
    },
  },

  // ── 11. DOWNGRADE PREVENTION ──────────────────────────────
  {
    organization_id: ORG_ID,
    title: 'Downgrade Prevention',
    title_en: 'Downgrade Prevention',
    description: 'Comprendre les raisons et proposer des alternatives au downgrade complet. 5 etapes sur 3 jours.',
    description_en: 'Understand reasons and propose alternatives to a full downgrade. 5 steps over 3 days.',
    playbook_type: 'semi_automated',
    template_category: 'downgrade_prevention',
    priority: 'high',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'J+0 : Questionnaire interception',
        config: {
          email_subject: '[ACTION] Demande de downgrade detectee — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#f59e0b;">Downgrade detecte</h2><p>{{csm.name}},</p><p>Le compte {{account.id}} montre des signaux de downgrade :</p><ul><li>Health Score : {{account.health_score}}/100</li><li>MRR : {{account.mrr_eur}} EUR</li><li>Sieges : {{account.seat_count}}/{{account.seat_limit}}</li></ul><p><strong>Envoyer le questionnaire au client :</strong></p><ol><li>Raison principale (budget/features/equipe/insatisfaction)</li><li>Que pourrions-nous faire pour eviter le downgrade ?</li><li>Temporaire ou permanent ?</li></ol>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 2, delay_days: 0, action_type: 'slack_notify',
        title: 'J+0 : Notification CSM Slack',
        config: { channel: '#cs-saves', template: 'downgrade_alert' },
      },
      {
        step_order: 3, delay_days: 1, action_type: 'send_email',
        title: 'J+1 : Contre-offre basee sur raison',
        config: {
          email_subject: 'Options alternatives au downgrade — {{account.id}}',
          email_body_html: emailHtml('<h2>Contre-offre</h2><p>Selon la raison du downgrade, proposer :</p><ul><li><strong>Budget :</strong> Paiement annuel (-X%) ou report 60 jours</li><li><strong>Features non utilisees :</strong> Audit rapide 15 min</li><li><strong>Equipe reduite :</strong> Reduire les sieges sans changer de plan</li></ul><p>MRR actuel : {{account.mrr_eur}} EUR</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 2, action_type: 'create_task',
        title: 'J+2 : Appel telephonique CSM',
        config: { title: 'Appel save — Comprendre la vraie raison du downgrade', due_days: 1 },
      },
      {
        step_order: 5, delay_days: 3, action_type: 'send_email',
        title: 'J+3 : Derniere offre CEO',
        config: {
          email_subject: 'Offre personnelle CEO — {{account.id}}',
          email_body_html: emailHtml('<h2>Derniere offre — CEO</h2><p>Si le compte depasse 20K EUR ARR :</p><ul><li>2 mois gratuits sur le plan actuel</li><li>Aucun engagement</li><li>Evaluation de la valeur</li></ul><p>Sinon, executer le downgrade et envoyer le guide des fonctionnalites perdues + option undo 14 jours.</p><p>ARR : {{account.arr_eur}} EUR</p>'),
          email_from_name: 'Sentio AI — Direction',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'health_score', operator: 'lte', value: 50 },
      ],
    },
  },

  // ── 12. SUCCESS PLANNING STRATEGIQUE ──────────────────────
  {
    organization_id: ORG_ID,
    title: 'Success Planning Strategique',
    title_en: 'Strategic Success Planning',
    description: 'Co-construire un plan de succes aligne sur les OKR du client. 5 etapes sur 90 jours.',
    description_en: 'Co-build a success plan aligned with customer OKRs. 5 steps over 90 days.',
    playbook_type: 'semi_automated',
    template_category: 'success_planning',
    priority: 'medium',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'J+30 post-signature : Initialisation Success Plan',
        config: {
          email_subject: 'Construisons votre plan de succes 90 jours — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#4f46e5;">Success Plan 90 jours</h2><p>{{csm.name}},</p><p>Le compte {{account.id}} est pret pour un Success Plan :</p><ul><li>ARR : {{account.arr_eur}} EUR</li><li>Health : {{account.health_score}}/100</li></ul><p><strong>Session de co-creation (60 min) :</strong></p><ol><li>Definir 3 objectifs metier prioritaires</li><li>Identifier les KPIs de mesure</li><li>Creer la roadmap d\'adoption</li><li>Planifier les points de suivi</li></ol>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 2, delay_days: 5, action_type: 'send_email',
        title: 'J+35 : Envoi template Success Plan',
        config: {
          email_subject: 'Template Success Plan pre-rempli — {{account.id}}',
          email_body_html: emailHtml('<h2>Template Success Plan</h2><p>Envoyer le template pre-rempli avec les donnees du compte :</p><ul><li>Contexte & Objectifs Metier</li><li>KPIs de Succes (pre-remplis)</li><li>Milestones 30/60/90 jours</li><li>Ressources & Formation requises</li></ul>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 3, delay_days: 30, action_type: 'send_email',
        title: 'J+60 : Check-in Milestone 1',
        config: {
          email_subject: 'Check-in Success Plan — Milestone 1/3 — {{account.id}}',
          email_body_html: emailHtml('<h2>Check-in Milestone 1</h2><p>Point d\'etape sur le Success Plan :</p><ul><li>Health Score : {{account.health_score}}/100</li><li>Usage : {{account.product_usage_score}}/100</li><li>MRR : {{account.mrr_eur}} EUR</li></ul><p>Evaluer la progression vers les objectifs definis.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 60, action_type: 'send_email',
        title: 'J+90 : Check-in Milestone 2',
        config: {
          email_subject: 'Check-in Success Plan — Milestone 2/3 — {{account.id}}',
          email_body_html: emailHtml('<h2>Check-in Milestone 2</h2><p>Evaluation mi-parcours. Ajuster le plan si necessaire.</p><p>Health : {{account.health_score}} | Expansion : {{account.expansion_score}}</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 5, delay_days: 90, action_type: 'send_email',
        title: 'J+120 : Success Review finale',
        config: {
          email_subject: 'Success Review — 90 jours de resultats — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#10b981;">Success Review Finale</h2><p>Bilan des 90 jours :</p><table style="width:100%;border-collapse:collapse;margin:16px 0;"><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Health Score</td><td style="padding:8px;">{{account.health_score}}/100</td></tr><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Usage</td><td style="padding:8px;">{{account.product_usage_score}}/100</td></tr><tr><td style="padding:8px;font-weight:bold;">Expansion</td><td style="padding:8px;">{{account.expansion_score}}/100</td></tr></table><p>Planifier le prochain Success Plan (90 jours suivants).</p>'),
          email_from_name: 'Sentio AI',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'arr_cents', operator: 'gte', value: 2000000 },
      ],
    },
  },

  // ── 13. PAYMENT FAILURE RECOVERY ──────────────────────────
  {
    organization_id: ORG_ID,
    title: 'Payment Failure Recovery',
    title_en: 'Payment Failure Recovery',
    description: 'Recuperer les paiements echoues sans friction. Dunning intelligent en 8 etapes sur 30 jours.',
    description_en: 'Recover failed payments without friction. Smart dunning in 8 steps over 30 days.',
    playbook_type: 'automated',
    template_category: 'payment_recovery',
    priority: 'critical',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'J+0 : Notification paiement echoue',
        config: {
          email_subject: 'Paiement echoue detecte — {{account.id}} ({{account.mrr_eur}} EUR)',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Paiement echoue</h2><p>{{csm.name}},</p><p>Le paiement du compte {{account.id}} a echoue.</p><ul><li>MRR : {{account.mrr_eur}} EUR</li><li>Plan : {{account.plan_tier}}</li></ul><p>Notification interne — pas d\'action immediate (eviter la sur-sollicitation).</p>'),
          email_from_name: 'Sentio AI Billing',
        },
      },
      {
        step_order: 2, delay_days: 3, action_type: 'send_email',
        title: 'J+3 : Rappel + aide proactive',
        config: {
          email_subject: '[RAPPEL] Paiement en attente — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#f59e0b;">Paiement toujours en attente</h2><p>Le paiement de {{account.mrr_eur}} EUR est toujours en attente.</p><p>Proposer une aide proactive : verification bancaire, changement de moyen de paiement, FAQ.</p>'),
          email_from_name: 'Sentio AI Billing',
        },
      },
      {
        step_order: 3, delay_days: 5, action_type: 'send_email',
        title: 'J+5 : Escalade CSM',
        config: {
          email_subject: 'Probleme de paiement persistant — {{account.id}}',
          email_body_html: emailHtml('<h2>Escalade CSM</h2><p>Le probleme de paiement persiste depuis 5 jours.</p><p>{{csm.name}}, contacter le client directement :</p><ul><li>Emails de facturation recus ?</li><li>Probleme avec le processus de paiement ?</li><li>Besoin d\'une facture specifique ou bon de commande ?</li></ul>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 7, action_type: 'send_email',
        title: 'J+7 : Derniere chance avant suspension',
        config: {
          email_subject: 'DERNIER JOUR — Suspension imminente — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Suspension imminente</h2><p>L\'acces sera suspendu demain si le paiement n\'est pas regularise.</p><p>MRR : {{account.mrr_eur}} EUR</p><p>Reponse garantie sous 1h.</p>'),
          email_from_name: 'Sentio AI Urgence',
        },
      },
      {
        step_order: 5, delay_days: 8, action_type: 'send_email',
        title: 'J+8 : Suspension soft',
        config: {
          email_subject: 'Compte suspendu — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Compte suspendu</h2><p>Le compte est suspendu suite au paiement non regle.</p><p>Les donnees sont securisees (conservees 30 jours).</p><p>Pour reactiver : regulariser le paiement → acces retabli en 5 minutes.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 6, delay_days: 15, action_type: 'send_email',
        title: 'J+15 : Offre d\'arrangement',
        config: {
          email_subject: 'Options de paiement pour reactiver — {{account.id}}',
          email_body_html: emailHtml('<h2>Offre d\'arrangement</h2><p>Proposer des options :</p><ol><li>Paiement fractionne</li><li>Report de 30 jours (aucun frais)</li><li>Discussion personnalisee</li></ol>'),
          email_from_name: 'Sentio AI Billing',
        },
      },
      {
        step_order: 7, delay_days: 28, action_type: 'send_email',
        title: 'J+28 : Avant suppression definitive',
        config: {
          email_subject: '[DERNIERE ALERTE] Suppression dans 48h — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Suppression dans 48h</h2><p>Les donnees seront definitivement supprimees dans 48h.</p><p>Export manuel disponible. Regularisation encore possible.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 8, delay_days: 30, action_type: 'send_email',
        title: 'J+30 : Suppression + exit survey',
        config: {
          email_subject: 'Compte supprime — {{account.id}}',
          email_body_html: emailHtml('<h2>Compte supprime</h2><p>Le compte a ete supprime.</p><p>Envoyer un sondage de sortie (30 sec) et informer de l\'option recovery sous 7 jours.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'health_score', operator: 'lte', value: 30 },
      ],
    },
  },

  // ── 14. HEALTH MONITORING WEEKLY ──────────────────────────
  {
    organization_id: ORG_ID,
    title: 'Health Monitoring Weekly',
    title_en: 'Weekly Health Monitoring',
    description: 'Detection precoce des degradations avant qu\'elles ne deviennent critiques. Analyse hebdomadaire automatique.',
    description_en: 'Early detection of degradation before it becomes critical. Automated weekly analysis.',
    playbook_type: 'automated',
    template_category: 'health_monitoring',
    priority: 'high',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'J+0 : Digest hebdomadaire CSM',
        config: {
          email_subject: 'Health Report hebdomadaire — {{account.id}}',
          email_body_html: emailHtml('<h2>Health Report Hebdomadaire</h2><p>{{csm.name}},</p><p>Compte {{account.id}} — Signaux d\'alerte :</p><table style="width:100%;border-collapse:collapse;margin:16px 0;"><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Health Score</td><td style="padding:8px;">{{account.health_score}}/100</td></tr><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Churn Risk</td><td style="padding:8px;">{{account.churn_risk_score}}/100</td></tr><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Usage</td><td style="padding:8px;">{{account.product_usage_score}}/100</td></tr><tr><td style="padding:8px;font-weight:bold;">MRR</td><td style="padding:8px;">{{account.mrr_eur}} EUR</td></tr></table><p>Verifier si une action est necessaire.</p>'),
          email_from_name: 'Sentio AI Monitoring',
        },
      },
      {
        step_order: 2, delay_days: 1, action_type: 'send_email',
        title: 'J+1 : Email client — Baisse activite',
        config: {
          email_subject: 'Baisse d\'activite detectee — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#f59e0b;">Baisse d\'activite</h2><p>Nos systemes ont detecte une baisse d\'utilisation :</p><ul><li>Usage Score : {{account.product_usage_score}}/100</li><li>Health Score : {{account.health_score}}/100</li></ul><p>Si tout va bien, aucune action requise. Sinon, proposer aide :</p><ul><li>Support technique</li><li>Session avec le CSM</li></ul>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 3, delay_days: 3, action_type: 'send_email',
        title: 'J+3 : Felicitations si amelioration',
        config: {
          email_subject: 'Excellente progression — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#10b981;">Felicitations !</h2><p>Si le Health Score s\'est ameliore : envoyer un email de felicitations au client.</p><p>Health Score : {{account.health_score}}/100</p><p>Continuer l\'elan positif !</p>'),
          email_from_name: 'Sentio AI',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'health_score', operator: 'lte', value: 70 },
      ],
    },
  },

  // ── 15. CUSTOMER EDUCATION CERTIFICATION ──────────────────
  {
    organization_id: ORG_ID,
    title: 'Customer Education Certification',
    title_en: 'Customer Education Certification',
    description: 'Augmenter l\'adoption et la stickiness via la formation structuree. Programme de certification en 6 etapes sur 60 jours.',
    description_en: 'Increase adoption and stickiness through structured training. Certification programme in 6 steps over 60 days.',
    playbook_type: 'automated',
    template_category: 'customer_education',
    priority: 'medium',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'J+0 : Invitation certification',
        config: {
          email_subject: 'Invitation Certification {{org.name}} — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#4f46e5;">Certification {{org.name}}</h2><p>{{csm.name}},</p><p>Le compte {{account.id}} est pret pour la certification :</p><ul><li>Usage : {{account.product_usage_score}}/100 (potentiel non exploite)</li><li>Actif depuis > 60 jours</li></ul><p><strong>Programme (gratuit, en ligne) :</strong></p><ol><li>Module 1 : Fondamentaux (1h)</li><li>Module 2 : Fonctionnalites avancees (2h)</li><li>Module 3 : Best practices (1h30)</li><li>Examen final (30 min)</li></ol><p>Duree totale : ~5h sur 2 semaines. Places limitees.</p>'),
          email_from_name: 'Sentio AI Education',
        },
      },
      {
        step_order: 2, delay_days: 1, action_type: 'send_email',
        title: 'J+1 : Bienvenue certification',
        config: {
          email_subject: 'Bienvenue dans la Certification {{org.name}}',
          email_body_html: emailHtml('<h2>Bienvenue !</h2><p>Roadmap du programme :</p><ul><li>Semaine 1 : Modules 1 & 2</li><li>Semaine 2 : Module 3 + Examen</li></ul><p>Objectif : Badge certifie sous 14 jours !</p>'),
          email_from_name: 'Sentio AI Education',
        },
      },
      {
        step_order: 3, delay_days: 7, action_type: 'send_email',
        title: 'J+7 : Relance progression',
        config: {
          email_subject: 'Relance Certification — Ou en etes-vous ?',
          email_body_html: emailHtml('<h2>Relance progression</h2><p>Tips :</p><ul><li>Bloquer 30 min aujourd\'hui pour avancer</li><li>Module le plus court : 20 min</li><li>Taux de reussite examen : 92%</li></ul>'),
          email_from_name: 'Sentio AI Education',
        },
      },
      {
        step_order: 4, delay_days: 14, action_type: 'send_email',
        title: 'J+14 : Felicitations certification',
        config: {
          email_subject: 'Felicitations ! Certification obtenue — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#10b981;">Certification obtenue !</h2><p>Avantages actives :</p><ul><li>Badge "Certified" sur profil</li><li>Acces communaute Slack privee</li><li>Support prioritaire (SLA -50%)</li><li>Code promo 15%</li></ul><p>Prochaine etape : Certification Niveau 2 dans 90 jours.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 5, delay_days: 30, action_type: 'send_email',
        title: 'J+30 : Engagement post-certification',
        config: {
          email_subject: 'Post-certification — Comment utilisez-vous vos nouvelles competences ?',
          email_body_html: emailHtml('<h2>1 mois apres la certification</h2><p>Questions de feedback :</p><ul><li>Resultats concrets obtenus ?</li><li>Feature la plus utilisee maintenant ?</li><li>Cas d\'usage deploye ?</li></ul><p>Usage actuel : {{account.product_usage_score}}/100</p>'),
          email_from_name: 'Sentio AI Education',
        },
      },
      {
        step_order: 6, delay_days: 60, action_type: 'send_email',
        title: 'J+60 : Webinar avance certifies',
        config: {
          email_subject: '[CERTIFIES] Webinar Expert — Session avancee',
          email_body_html: emailHtml('<h2>Webinar Expert</h2><p>Webinar reserve aux certifies :</p><ul><li>Niveau : Expert</li><li>Duree : 60 min</li><li>Contenu technique avance</li><li>Q&A avec Lead Developer</li></ul>'),
          email_from_name: 'Sentio AI Education',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'product_usage_score', operator: 'gte', value: 40 },
        { field: 'product_usage_score', operator: 'lte', value: 60 },
      ],
    },
  },
]

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log('=== Sentio AI — Seed 15 Playbook Workflow Templates ===')
  console.log('Organization: ' + ORG_ID)
  console.log('')

  // 1. Archive existing templates
  console.log('Archiving existing templates...')
  const archiveRes = await fetch(
    SUPABASE_URL + '/rest/v1/playbooks?organization_id=eq.' + ORG_ID + '&is_template=eq.true&status=neq.archived',
    {
      method: 'PATCH',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        status: 'archived',
        deactivated_at: new Date().toISOString(),
        deactivation_reason: 'Replaced by V2 workflow templates',
      }),
    },
  )

  if (archiveRes.ok) {
    const archived = await archiveRes.json()
    console.log('  Archived ' + archived.length + ' existing templates')
  } else {
    console.log('  No existing templates to archive (or error: ' + archiveRes.status + ')')
  }

  // 2. Insert new templates
  console.log('')
  console.log('Inserting ' + templates.length + ' new workflow templates...')
  console.log('')

  let successCount = 0
  let errorCount = 0

  for (const template of templates) {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/playbooks',
      {
        method: 'POST',
        headers: {
          'apikey': SERVICE_KEY,
          'Authorization': 'Bearer ' + SERVICE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(template),
      },
    )

    if (res.ok) {
      const data = await res.json()
      const id = Array.isArray(data) ? data[0]?.id : data.id
      console.log('  ✓ [' + template.priority.toUpperCase() + '] ' + template.title + ' (' + (template.steps?.length || 0) + ' steps) — id: ' + (id || '?'))
      successCount++
    } else {
      const err = await res.text()
      console.error('  ✗ ' + template.title + ': ' + res.status + ' ' + err)
      errorCount++
    }
  }

  console.log('')
  console.log('=== Done! ===')
  console.log('  Success: ' + successCount + '/' + templates.length)
  if (errorCount > 0) {
    console.log('  Errors: ' + errorCount)
  }
}

main().catch(console.error)
