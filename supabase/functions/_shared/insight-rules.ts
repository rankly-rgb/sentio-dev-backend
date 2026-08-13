// ============================================================
// Insight Rules — Fonctions pures de génération d'insights IA
//
// Chaque règle évalue les scores/données d'un account et retourne
// un InsightCandidate si la condition est remplie, null sinon.
//
// Aucun accès DB — 100% testable.
// ============================================================

// ── Types ────────────────────────────────────────────────────

export type InsightType =
  | 'churn_prediction'
  | 'expansion_opportunity'
  | 'renewal_alert'
  | 'payment_risk'
  | 'payment_delinquent'
  | 'usage_drop'
  | 'account_health_summary'

export type InsightPriority = 'low' | 'medium' | 'high' | 'critical'

// Scoring Engine V2 (S5) : les règles ci-dessous évaluent des seuils
// déterministes sur des données Stripe/produit — pas de modèle probabiliste.
// `severity` + `signals` remplacent `confidence_score` (toujours null
// désormais, colonne conservée pour compat descendante — voir migration
// 20260725000001_scoring_engine_v3.sql).
export type InsightSeverity = 'CRITIQUE' | 'MAJEUR' | 'MINEUR'

export interface InsightInput {
  account_id: string
  organization_id: string
  health_score: number
  churn_risk_score: number
  expansion_score: number
  mrr_cents: number
  contract_end_date: string | null
  has_overdue_invoices: boolean
  overdue_days: number
  // accounts.is_delinquent — statut d'abonnement Stripe past_due/unpaid,
  // indépendant des factures (audit délinquence 2026-08-06, issue #36).
  is_delinquent: boolean
  usage_score_current: number
  usage_score_previous: number | null
  created_at: string
}

export interface InsightCandidate {
  insight_type: InsightType
  title: string
  description: string
  recommended_action: string
  priority: InsightPriority
  severity: InsightSeverity
  signals: string[]
  // Toujours null (S5) : règle déterministe, pas de fausse précision
  // probabiliste. Champ conservé pour compat de schéma DB uniquement.
  confidence_score: null
  mrr_impact_cents: number
  source_scores: Record<string, number>
}

// ── Helpers ──────────────────────────────────────────────────

function mrrUsd(cents: number): string {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function daysUntil(dateStr: string): number {
  const now = new Date()
  const target = new Date(dateStr)
  return Math.floor((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}

// ── Règle 1 : Churn Prediction ──────────────────────────────

export function evaluateChurnPrediction(input: InsightInput): InsightCandidate | null {
  if (input.churn_risk_score < 70) return null

  const isCritical = input.churn_risk_score >= 80
  const priority: InsightPriority = isCritical ? 'critical' : 'high'
  const severity: InsightSeverity = isCritical ? 'CRITIQUE' : 'MAJEUR'

  return {
    insight_type: 'churn_prediction',
    title: isCritical
      ? 'Critical churn risk detected'
      : 'High churn risk detected',
    description: `This account has a churn risk of ${input.churn_risk_score}% with a health score of ${input.health_score}%. MRR at risk: ${mrrUsd(input.mrr_cents)}.`,
    recommended_action: isCritical
      ? 'Immediate CSM intervention required. Schedule a retention call within 48h.'
      : 'Schedule a follow-up with the customer within the week.',
    priority,
    severity,
    signals: [isCritical ? 'churn_risk_score >= 80' : 'churn_risk_score >= 70'],
    confidence_score: null,
    mrr_impact_cents: input.mrr_cents,
    source_scores: {
      churn_risk_score: input.churn_risk_score,
      health_score: input.health_score,
    },
  }
}

// ── Règle 2 : Expansion Opportunity ─────────────────────────

export function evaluateExpansionOpportunity(input: InsightInput): InsightCandidate | null {
  if (input.expansion_score < 70 || input.health_score < 60) return null

  const isHigh = input.expansion_score >= 85
  const priority: InsightPriority = isHigh ? 'high' : 'medium'
  const severity: InsightSeverity = isHigh ? 'MAJEUR' : 'MINEUR'
  const estimatedExpansion = Math.round(input.mrr_cents * 0.3)

  return {
    insight_type: 'expansion_opportunity',
    title: isHigh
      ? 'Strong expansion opportunity identified'
      : 'Expansion opportunity detected',
    description: `Expansion score of ${input.expansion_score}% with good health (${input.health_score}%). Estimated expansion potential: ${mrrUsd(estimatedExpansion)}/month.`,
    recommended_action: isHigh
      ? 'Propose a plan upgrade or additional seats at the next check-in.'
      : 'Monitor progress and prepare an upsell proposal.',
    priority,
    severity,
    signals: [isHigh ? 'expansion_score >= 85' : 'expansion_score >= 70', 'health_score >= 60'],
    confidence_score: null,
    mrr_impact_cents: estimatedExpansion,
    source_scores: {
      expansion_score: input.expansion_score,
      health_score: input.health_score,
    },
  }
}

// ── Règle 3 : Renewal Alert ─────────────────────────────────

export function evaluateRenewalAlert(input: InsightInput): InsightCandidate | null {
  if (!input.contract_end_date) return null

  const days = daysUntil(input.contract_end_date)
  if (days > 60) return null

  const isExpired = days < 0
  const isCritical = days <= 30
  const priority: InsightPriority = (isExpired || isCritical) ? 'critical' : 'high'
  const severity: InsightSeverity = (isExpired || isCritical) ? 'CRITIQUE' : 'MAJEUR'

  return {
    insight_type: 'renewal_alert',
    title: isExpired
      ? `Contract expired ${Math.abs(days)} days ago`
      : isCritical
        ? 'Renewal imminent (< 30 days)'
        : 'Renewal upcoming (< 60 days)',
    description: isExpired
      ? `The contract expired ${Math.abs(days)} days ago. Account MRR: ${mrrUsd(input.mrr_cents)}. Health score: ${input.health_score}%.`
      : `The contract expires in ${days} days. Account MRR: ${mrrUsd(input.mrr_cents)}. Health score: ${input.health_score}%.`,
    recommended_action: isExpired
      ? 'Contract expired — handle as urgent. Contact the decision-maker immediately to resolve.'
      : isCritical
        ? 'Start the renewal process immediately. Contact the decision-maker.'
        : 'Prepare the renewal proposal and schedule a business review.',
    priority,
    severity,
    signals: [isExpired ? 'contract_end_date < today' : isCritical ? 'days_until_renewal <= 30' : 'days_until_renewal <= 60'],
    confidence_score: null,
    mrr_impact_cents: input.mrr_cents,
    source_scores: {
      health_score: input.health_score,
      days_until_renewal: days,
    },
  }
}

// ── Règle 4 : Payment Risk ──────────────────────────────────

export function evaluatePaymentRisk(input: InsightInput): InsightCandidate | null {
  if (!input.has_overdue_invoices || input.overdue_days <= 15) return null

  const isCritical = input.overdue_days > 30
  const priority: InsightPriority = isCritical ? 'critical' : 'high'
  const severity: InsightSeverity = isCritical ? 'CRITIQUE' : 'MAJEUR'

  return {
    insight_type: 'payment_risk',
    title: isCritical
      ? 'Critical overdue payment (> 30 days)'
      : 'Late payment detected (> 15 days)',
    description: `Invoice(s) overdue for ${input.overdue_days} days. MRR at risk: ${mrrUsd(input.mrr_cents)}.`,
    recommended_action: isCritical
      ? 'Escalate to finance. Send a formal reminder and consider suspension.'
      : 'Send a payment reminder to the customer and verify billing details.',
    priority,
    severity,
    signals: [isCritical ? 'overdue_days > 30' : 'overdue_days > 15'],
    confidence_score: null,
    mrr_impact_cents: input.mrr_cents,
    source_scores: {
      overdue_days: input.overdue_days,
    },
  }
}

// ── Règle 4bis : Payment Delinquent ─────────────────────────
//
// Issue #36 (2026-08-13) : pendant de `payment_risk` pour le signal
// `accounts.is_delinquent` (statut d'abonnement Stripe past_due/unpaid),
// jamais surfacé par un insight dédié avant ce chantier — un compte
// délinquent ne remontait que si ses *autres* signaux franchissaient un
// seuil existant. Même exclusion mutuelle avec payment_risk que le signal
// de churn équivalent (_shared/scoring.ts, audit délinquence 2026-08-06,
// décision 1) : une fois la facture confirmée en retard de 15j+
// (payment_risk se déclenche), le proxy de statut s'efface au lieu de
// s'additionner — même fait observé à deux précisions différentes.

export function evaluatePaymentDelinquent(input: InsightInput): InsightCandidate | null {
  if (!input.is_delinquent) return null
  if (input.has_overdue_invoices && input.overdue_days > 15) return null

  return {
    insight_type: 'payment_delinquent',
    title: 'Payment past due',
    description: `This account's subscription payment has failed and is past due. MRR at risk: ${mrrUsd(input.mrr_cents)}.`,
    recommended_action: 'Reach out to the customer to resolve the failed payment before the account is suspended.',
    priority: 'critical',
    severity: 'CRITIQUE',
    signals: ['is_delinquent = true'],
    confidence_score: null,
    mrr_impact_cents: input.mrr_cents,
    source_scores: {
      churn_risk_score: input.churn_risk_score,
    },
  }
}

// ── Règle 5 : Usage Drop — GELÉE (retirée du jeu de règles actif, 2026-08-04) ─
//
// AUDIT_LOGIQUE_METIER_STRIPE.md point 19 : `product_usage_score` est gelé
// depuis le passage au moteur de scoring v3 (dimension retirée du modèle,
// même statut que `financial_score`/`engagement_score`/`contract_score` —
// voir `accounts-api/index.ts`, pattern "gelé"/"Score à venir"). Rien ne
// l'écrit plus depuis `calculate-scores/index.ts` : `usage_score_current`
// (buildInsightInput, generate-insights/index.ts) retombe systématiquement
// sur le défaut `?? 50`, et `usage_score_previous` (lu depuis
// `score_history.product_usage_score`, colonne également gelée) est soit
// `null`, soit une valeur figée d'avant le cutover v3 — jamais une donnée
// à 14 jours malgré ce que dit le texte de l'insight ci-dessous. La règle
// comparait donc une valeur figée à une valeur figée/nulle, générant des
// insights sur des données mortes.
//
// Fonction conservée (pas supprimée) pour permettre une réactivation
// propre le jour où une vraie dimension "usage produit" v3 existe — retirée
// uniquement du tableau `rules` de `evaluateInsightRules` ci-dessous. Ne
// pas la réintroduire sans réintroduire d'abord un vrai signal usage.
export function evaluateUsageDrop(input: InsightInput): InsightCandidate | null {
  if (input.usage_score_previous === null || input.usage_score_previous === 0) return null
  if (input.usage_score_current >= input.usage_score_previous * 0.7) return null

  const dropPct = Math.round(
    ((input.usage_score_previous - input.usage_score_current) / input.usage_score_previous) * 100
  )
  const isSevere = dropPct >= 50
  const priority: InsightPriority = isSevere ? 'high' : 'medium'
  const severity: InsightSeverity = isSevere ? 'MAJEUR' : 'MINEUR'

  return {
    insight_type: 'usage_drop',
    title: isSevere
      ? 'Severe usage drop detected (> 50%)'
      : 'Significant usage decline detected (> 30%)',
    description: `Usage dropped by ${dropPct}% over the last 14 days (score ${input.usage_score_previous} → ${input.usage_score_current}). Account MRR: ${mrrUsd(input.mrr_cents)}.`,
    recommended_action: isSevere
      ? 'Contact the customer urgently to understand the reason for the usage drop.'
      : 'Monitor progress over the next week and schedule a check-in.',
    priority,
    severity,
    signals: [isSevere ? 'usage_drop_pct >= 50' : 'usage_drop_pct >= 30'],
    confidence_score: null,
    mrr_impact_cents: Math.round(input.mrr_cents * (dropPct / 100)),
    source_scores: {
      usage_score_current: input.usage_score_current,
      usage_score_previous: input.usage_score_previous,
      drop_pct: dropPct,
    },
  }
}

// ── Règle 6 : Account Health Summary (fallback) ─────────────
// Fires for paying accounts when no specific issue is detected.
// Guarantees at least 1 insight per account from Day 1 of onboarding.

export function evaluateAccountHealthSummary(input: InsightInput): InsightCandidate | null {
  if (input.mrr_cents <= 0) return null

  const health = input.health_score
  const churn = input.churn_risk_score

  let priority: InsightPriority
  let severity: InsightSeverity
  let title: string
  let description: string
  let action: string

  if (health < 30) {
    priority = 'critical'
    severity = 'CRITIQUE'
    title = 'Account in critical condition'
    description = `Very low health score (${health}%) with a churn risk of ${churn}%. MRR: ${mrrUsd(input.mrr_cents)}. Situation requires immediate attention.`
    action = 'Analyze the causes of the low score and contact the customer within 48h.'
  } else if (health < 50) {
    priority = 'high'
    severity = 'MAJEUR'
    title = 'At-risk account — monitoring required'
    description = `Health score of ${health}% with a churn risk of ${churn}%. MRR: ${mrrUsd(input.mrr_cents)}. Increased follow-up recommended.`
    action = 'Schedule a check-in with the customer within the next 7 days.'
  } else if (health < 70) {
    priority = 'medium'
    severity = 'MINEUR'
    title = 'Account to watch'
    description = `Health score of ${health}% with a churn risk of ${churn}%. MRR: ${mrrUsd(input.mrr_cents)}. Progress to monitor.`
    action = 'Perform a monthly follow-up and monitor how the indicators evolve.'
  } else {
    priority = 'low'
    severity = 'MINEUR'
    title = 'Account in good health'
    description = `Health score of ${health}% with a low churn risk (${churn}%). MRR: ${mrrUsd(input.mrr_cents)}. Stable account.`
    action = 'Maintain current engagement and identify expansion opportunities.'
  }

  return {
    insight_type: 'account_health_summary',
    title,
    description,
    recommended_action: action,
    priority,
    severity,
    signals: [`health_score in [${health < 30 ? '0,30' : health < 50 ? '30,50' : health < 70 ? '50,70' : '70,100'})`],
    confidence_score: null,
    mrr_impact_cents: input.mrr_cents,
    source_scores: {
      health_score: health,
      churn_risk_score: churn,
    },
  }
}

// ── Orchestrateur ────────────────────────────────────────────

export function evaluateInsightRules(input: InsightInput): InsightCandidate[] {
  const candidates: InsightCandidate[] = []

  const rules = [
    evaluateChurnPrediction,
    evaluateExpansionOpportunity,
    evaluateRenewalAlert,
    evaluatePaymentRisk,
    evaluatePaymentDelinquent,
    // evaluateUsageDrop retirée (product_usage_score gelé depuis le v3 —
    // voir commentaire sur la fonction ci-dessus).
  ]

  for (const rule of rules) {
    const result = rule(input)
    if (result) candidates.push(result)
  }

  // Fallback: generate a health summary when no specific issue is detected
  if (candidates.length === 0) {
    const summary = evaluateAccountHealthSummary(input)
    if (summary) candidates.push(summary)
  }

  return candidates
}
