// ============================================================
// Shared : score-narratives
// Génère des phrases contextuelles déterministes (EN) pour
// chaque dimension du score de santé.
// Utilisé par : accounts-api (à la volée) + calculate-scores (persisté en DB).
// ============================================================

export interface NarrativeInputs {
  // Scores calculés
  health_score: number | null
  financial_score: number | null
  product_usage_score: number | null
  engagement_score: number | null
  contract_score: number | null
  // Données brutes nécessaires aux phrases
  mrr_cents: number
  contract_start_date: string | null
  contract_end_date: string | null
  billing_interval: string | null
  overdue_count: number
  overdue_amount_cents: number
  total_events_30d: number
  open_ticket_count: number | null
  last_meeting_date: string | null
}

export interface ScoreNarratives {
  health_narrative: string
  financial_narrative: string
  usage_narrative: string
  engagement_narrative: string
  contract_narrative: string
}

export function generateNarratives(inputs: NarrativeInputs): ScoreNarratives {
  return {
    health_narrative: narrativeHealth(inputs.health_score),
    financial_narrative: narrativeFinancial(
      inputs.mrr_cents,
      inputs.financial_score,
      inputs.contract_start_date,
      inputs.overdue_count,
      inputs.overdue_amount_cents,
    ),
    usage_narrative: narrativeUsage(inputs.product_usage_score, inputs.total_events_30d),
    engagement_narrative: narrativeEngagement(
      inputs.engagement_score,
      inputs.open_ticket_count,
      inputs.last_meeting_date,
    ),
    contract_narrative: narrativeContract(
      inputs.contract_score,
      inputs.contract_end_date,
      inputs.billing_interval,
    ),
  }
}

// ── Dimension narratives ─────────────────────────────────────

function narrativeHealth(health_score: number | null): string {
  if (health_score === null) return "Health score not yet calculated."
  if (health_score >= 80) return `Excellent health score (${health_score}/100).`
  if (health_score >= 60) return `Fair health score (${health_score}/100). Some areas for improvement.`
  if (health_score >= 40) return `Degraded health score (${health_score}/100). Attention required.`
  return `Critical health score (${health_score}/100). Urgent intervention recommended.`
}

function narrativeFinancial(
  mrr_cents: number,
  financial_score: number | null,
  contract_start_date: string | null,
  overdueCount: number,
  overdueAmountCents: number,
): string {
  if (mrr_cents === 0) return "Account with no active MRR — subscription canceled or suspended."

  const score = financial_score ?? 0
  const mrrEur = (mrr_cents / 100).toFixed(0)

  if (score >= 90) {
    const tenureMonths = contract_start_date
      ? Math.floor((Date.now() - new Date(contract_start_date).getTime()) / (1000 * 60 * 60 * 24 * 30))
      : null
    const tenureStr = tenureMonths !== null ? `, active subscription for ${tenureMonths} months` : ''
    return `No overdue invoices${tenureStr}. MRR: €${mrrEur}.`
  }
  if (score >= 70) return `Stable billing. MRR: €${mrrEur}.`
  if (score >= 50) {
    return `Warning: ${overdueCount} overdue invoice(s) (€${(overdueAmountCents / 100).toFixed(0)}).`
  }
  return `High financial risk: ${overdueCount} overdue invoice(s) totaling €${(overdueAmountCents / 100).toFixed(0)}.`
}

function narrativeUsage(product_usage_score: number | null, totalEvents30d: number): string {
  const score = product_usage_score ?? 50
  if (score === 50 && totalEvents30d === 0) return "No usage data available."
  if (score >= 80) return `Active usage: ${totalEvents30d} events over the last 30 days.`
  if (score >= 60) return `Moderate usage: ${totalEvents30d} events over the last 30 days.`
  if (score >= 40) return `Low usage detected: only ${totalEvents30d} events over 30 days.`
  return `Very low or inactive usage (${totalEvents30d} events). Risk of disengagement.`
}

function narrativeEngagement(
  engagement_score: number | null,
  openTicketCount: number | null,
  lastMeetingDate: string | null,
): string {
  if (openTicketCount === null && lastMeetingDate === null) {
    return "No HubSpot data available for engagement."
  }
  const score = engagement_score ?? 50
  const ticketCount = openTicketCount ?? 0
  const daysSinceMeeting = lastMeetingDate
    ? Math.floor((Date.now() - new Date(lastMeetingDate).getTime()) / (1000 * 60 * 60 * 24))
    : null

  if (score >= 70) {
    const meetingStr = daysSinceMeeting !== null ? `, last meeting ${daysSinceMeeting} day(s) ago` : ''
    return `Good engagement${meetingStr}.`
  }
  if (score >= 40) {
    const ticketStr = ticketCount > 0 ? ` — ${ticketCount} open ticket(s).` : '.'
    return `Moderate engagement${ticketStr}`
  }
  const ticketStr = ticketCount > 0 ? `${ticketCount} open ticket(s)` : 'no ticket data'
  const meetingStr = daysSinceMeeting !== null
    ? `, last meeting ${daysSinceMeeting} days ago`
    : ', no recent meeting'
  return `Low engagement: ${ticketStr}${meetingStr}.`
}

function narrativeContract(
  contract_score: number | null,
  contract_end_date: string | null,
  billing_interval: string | null,
): string {
  if (!contract_end_date) {
    const intervalMap: Record<string, string> = { monthly: 'monthly', annual: 'annual' }
    const intervalStr = billing_interval ? (intervalMap[billing_interval] ?? billing_interval) : 'unspecified'
    return `${intervalStr.charAt(0).toUpperCase()}${intervalStr.slice(1)} subscription, no renewal date on file.`
  }

  const daysUntil = Math.floor((new Date(contract_end_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))

  if (daysUntil < 0) return `Contract expired ${Math.abs(daysUntil)} day(s) ago. Action required.`
  if (daysUntil < 30) return `Critical renewal: in ${daysUntil} day(s) (${contract_end_date}).`
  if (daysUntil < 60) return `Renewal imminent: in ${daysUntil} days (${contract_end_date}).`
  if (daysUntil < 90) return `Renewal in ${daysUntil} days — to plan.`
  return `Active contract, renewal in ${daysUntil} days (${contract_end_date}).`
}

// ── Scoring Engine V2 (model_version 'v3') narratives ─────────
// Réutilise health_narrative/financial_narrative/contract_narrative
// (colonnes existantes, non renommées) avec le nouveau sens v3 :
// financial_narrative ⇐ payment_health, contract_narrative ⇐ contract_renewal.
// usage_narrative/engagement_narrative ne sont plus régénérés (dimensions
// retirées du modèle v3, S1/S2) — le caller doit les omettre de l'update
// pour les laisser figés à leur dernière valeur v2, pas les écraser par une
// fausse phrase "à venir".
export interface NarrativeInputsV3 {
  health_score_points: number | null
  health_score_status: 'complete' | 'partial' | 'insufficient'
  payment_health_score: number | null
  revenue_dynamics_score: number | null
  contract_renewal_score: number | null
  mrr_cents: number
  overdue_count: number
  overdue_amount_cents: number
  contract_end_date: string | null
  billing_interval: string | null
  // D-NEXT (2026-08-04) : distinct de mrr_cents=0, voir narrativePaymentHealth.
  churn_risk_band: 'low' | 'watch' | 'high' | 'churned' | null
}

export interface ScoreNarrativesV3 {
  health_narrative: string
  financial_narrative: string
  contract_narrative: string
}

export function generateNarrativesV3(inputs: NarrativeInputsV3): ScoreNarrativesV3 {
  return {
    health_narrative: narrativeHealthV3(inputs.health_score_points, inputs.health_score_status),
    financial_narrative: narrativePaymentHealth(inputs.payment_health_score, inputs.mrr_cents, inputs.overdue_count, inputs.overdue_amount_cents, inputs.churn_risk_band),
    contract_narrative: inputs.contract_renewal_score !== null
      ? narrativeContract(inputs.contract_renewal_score, inputs.contract_end_date, inputs.billing_interval)
      : 'Contract renewal score not available — missing billing interval or contract dates.',
  }
}

function narrativeHealthV3(points: number | null, status: 'complete' | 'partial' | 'insufficient'): string {
  if (status === 'insufficient' || points === null) {
    return 'Health score unavailable — fewer than 50% of scoring dimensions have data for this account.'
  }
  const label = status === 'partial' ? ' (partial coverage)' : ''
  if (points >= 70) return `Healthy account${label} (${points} pts).`
  if (points >= 40) return `Account to watch${label} (${points} pts).`
  return `At-risk account${label} (${points} pts). Attention required.`
}

function narrativePaymentHealth(
  score: number | null,
  mrrCents: number,
  overdueCount: number,
  overdueAmountCents: number,
  churnRiskBand: 'low' | 'watch' | 'high' | 'churned' | null,
): string {
  // Bug trouvé lors de l'auto-vérification adversariale du 2026-08-04
  // (IMPLEMENTATION_LOG.md) : cette branche testait mrrCents === 0 (le
  // critère D1), qui matche aussi bien un compte réellement churned qu'un
  // compte invoice-only/usage-based non chiffrable (mrr_cents=0 sans être
  // parti — voir D-NEXT, docs/openspec.md §5). Le texte "canceled or
  // suspended" était donc trompeur pour ce second cas. churnRiskBand est
  // la valeur déjà réconciliée avec isAccountChurned() par scoreAccountPure.
  if (churnRiskBand === 'churned') return 'Account churned — subscription canceled.'
  if (score === null) return 'Payment health score not available — not enough invoice history yet.'
  const mrrUsd = (mrrCents / 100).toFixed(0)
  if (score >= 90) return `No overdue invoices. MRR: $${mrrUsd}.`
  if (score >= 70) return `Stable billing. MRR: $${mrrUsd}.`
  if (score >= 50) return `Warning: ${overdueCount} overdue invoice(s) ($${(overdueAmountCents / 100).toFixed(0)}).`
  return `High payment risk: ${overdueCount} overdue invoice(s) totaling $${(overdueAmountCents / 100).toFixed(0)}.`
}
