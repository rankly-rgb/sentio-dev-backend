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
  | 'usage_drop'

export type InsightPriority = 'low' | 'medium' | 'high' | 'critical'

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
  confidence_score: number
  mrr_impact_cents: number
  source_scores: Record<string, number>
}

// ── Helpers ──────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function mrrEur(cents: number): string {
  return (cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
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
  const confidence = clamp(input.churn_risk_score, 0, 95)

  return {
    insight_type: 'churn_prediction',
    title: isCritical
      ? 'Risque de churn critique détecté'
      : 'Risque de churn élevé détecté',
    description: `Ce compte présente un risque de churn de ${input.churn_risk_score}% avec un score de santé de ${input.health_score}%. MRR à risque : ${mrrEur(input.mrr_cents)} €.`,
    recommended_action: isCritical
      ? 'Intervention immédiate du CSM requise. Planifier un appel de rétention dans les 48h.'
      : 'Planifier un point de suivi avec le client dans la semaine.',
    priority,
    confidence_score: confidence,
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
  const confidence = clamp(input.expansion_score, 0, 95)
  const estimatedExpansion = Math.round(input.mrr_cents * 0.3)

  return {
    insight_type: 'expansion_opportunity',
    title: isHigh
      ? 'Forte opportunité d\'expansion identifiée'
      : 'Opportunité d\'expansion détectée',
    description: `Score d'expansion de ${input.expansion_score}% avec une bonne santé (${input.health_score}%). Potentiel d'expansion estimé : ${mrrEur(estimatedExpansion)} €/mois.`,
    recommended_action: isHigh
      ? 'Proposer un upgrade de plan ou des sièges supplémentaires lors du prochain point.'
      : 'Surveiller l\'évolution et préparer une proposition d\'upsell.',
    priority,
    confidence_score: confidence,
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
  const confidence = isExpired ? 95 : isCritical ? 90 : 75

  return {
    insight_type: 'renewal_alert',
    title: isExpired
      ? `Contrat expiré depuis ${Math.abs(days)} jours`
      : isCritical
        ? 'Renouvellement imminent (< 30 jours)'
        : 'Renouvellement à prévoir (< 60 jours)',
    description: isExpired
      ? `Le contrat a expiré il y a ${Math.abs(days)} jours. MRR du compte : ${mrrEur(input.mrr_cents)} €. Score de santé : ${input.health_score}%.`
      : `Le contrat expire dans ${days} jours. MRR du compte : ${mrrEur(input.mrr_cents)} €. Score de santé : ${input.health_score}%.`,
    recommended_action: isExpired
      ? 'Contrat expiré — traiter en urgence. Contacter le décideur immédiatement pour régularisation.'
      : isCritical
        ? 'Initier le processus de renouvellement immédiatement. Contacter le décideur.'
        : 'Préparer la proposition de renouvellement et planifier un point commercial.',
    priority,
    confidence_score: confidence,
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
  const confidence = isCritical ? 85 : 70

  return {
    insight_type: 'payment_risk',
    title: isCritical
      ? 'Impayé critique (> 30 jours)'
      : 'Retard de paiement détecté (> 15 jours)',
    description: `Facture(s) impayée(s) depuis ${input.overdue_days} jours. MRR à risque : ${mrrEur(input.mrr_cents)} €.`,
    recommended_action: isCritical
      ? 'Escalader au service financier. Envoyer une relance formelle et envisager la suspension.'
      : 'Envoyer un rappel de paiement au client et vérifier les coordonnées bancaires.',
    priority,
    confidence_score: confidence,
    mrr_impact_cents: input.mrr_cents,
    source_scores: {
      overdue_days: input.overdue_days,
    },
  }
}

// ── Règle 5 : Usage Drop ────────────────────────────────────

export function evaluateUsageDrop(input: InsightInput): InsightCandidate | null {
  if (input.usage_score_previous === null || input.usage_score_previous === 0) return null
  if (input.usage_score_current >= input.usage_score_previous * 0.7) return null

  const dropPct = Math.round(
    ((input.usage_score_previous - input.usage_score_current) / input.usage_score_previous) * 100
  )
  const isSevere = dropPct >= 50
  const priority: InsightPriority = isSevere ? 'high' : 'medium'
  const confidence = clamp(Math.round(dropPct * 1.2), 30, 90)

  return {
    insight_type: 'usage_drop',
    title: isSevere
      ? 'Chute d\'usage sévère détectée (> 50%)'
      : 'Baisse d\'usage significative détectée (> 30%)',
    description: `L'usage a chuté de ${dropPct}% sur les 14 derniers jours (score ${input.usage_score_previous} → ${input.usage_score_current}). MRR du compte : ${mrrEur(input.mrr_cents)} €.`,
    recommended_action: isSevere
      ? 'Contacter le client en urgence pour comprendre la raison de la chute d\'usage.'
      : 'Surveiller l\'évolution sur la prochaine semaine et planifier un check-in.',
    priority,
    confidence_score: confidence,
    mrr_impact_cents: Math.round(input.mrr_cents * (dropPct / 100)),
    source_scores: {
      usage_score_current: input.usage_score_current,
      usage_score_previous: input.usage_score_previous,
      drop_pct: dropPct,
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
    evaluateUsageDrop,
  ]

  for (const rule of rules) {
    const result = rule(input)
    if (result) candidates.push(result)
  }

  return candidates
}
