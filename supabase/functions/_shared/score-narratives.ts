// ============================================================
// Shared : score-narratives
// Génère des phrases contextuelles déterministes (FR) pour
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
  if (health_score === null) return "Score de santé non encore calculé."
  if (health_score >= 80) return `Score de santé excellent (${health_score}/100).`
  if (health_score >= 60) return `Score de santé correct (${health_score}/100). Quelques axes d'amélioration.`
  if (health_score >= 40) return `Score de santé dégradé (${health_score}/100). Attention requise.`
  return `Score de santé critique (${health_score}/100). Intervention urgente recommandée.`
}

function narrativeFinancial(
  mrr_cents: number,
  financial_score: number | null,
  contract_start_date: string | null,
  overdueCount: number,
  overdueAmountCents: number,
): string {
  if (mrr_cents === 0) return "Compte sans MRR actif — abonnement résilié ou suspendu."

  const score = financial_score ?? 0
  const mrrEur = (mrr_cents / 100).toFixed(0)

  if (score >= 90) {
    const tenureMonths = contract_start_date
      ? Math.floor((Date.now() - new Date(contract_start_date).getTime()) / (1000 * 60 * 60 * 24 * 30))
      : null
    const tenureStr = tenureMonths !== null ? `, abonnement actif depuis ${tenureMonths} mois` : ''
    return `Aucun impayé${tenureStr}. MRR : ${mrrEur} €.`
  }
  if (score >= 70) return `Facturation stable. MRR : ${mrrEur} €.`
  if (score >= 50) {
    return `Attention : ${overdueCount} facture(s) en retard (${(overdueAmountCents / 100).toFixed(0)} €).`
  }
  return `Risque financier élevé : ${overdueCount} impayé(s) pour ${(overdueAmountCents / 100).toFixed(0)} € au total.`
}

function narrativeUsage(product_usage_score: number | null, totalEvents30d: number): string {
  const score = product_usage_score ?? 50
  if (score === 50 && totalEvents30d === 0) return "Aucune donnée d'utilisation disponible."
  if (score >= 80) return `Utilisation active : ${totalEvents30d} événements sur les 30 derniers jours.`
  if (score >= 60) return `Utilisation modérée : ${totalEvents30d} événements sur les 30 derniers jours.`
  if (score >= 40) return `Faible utilisation détectée : seulement ${totalEvents30d} événements sur 30 jours.`
  return `Utilisation très faible ou inactive (${totalEvents30d} événements). Risque de désengagement.`
}

function narrativeEngagement(
  engagement_score: number | null,
  openTicketCount: number | null,
  lastMeetingDate: string | null,
): string {
  if (openTicketCount === null && lastMeetingDate === null) {
    return "Aucune donnée HubSpot disponible pour l'engagement."
  }
  const score = engagement_score ?? 50
  const ticketCount = openTicketCount ?? 0
  const daysSinceMeeting = lastMeetingDate
    ? Math.floor((Date.now() - new Date(lastMeetingDate).getTime()) / (1000 * 60 * 60 * 24))
    : null

  if (score >= 70) {
    const meetingStr = daysSinceMeeting !== null ? `, dernière réunion il y a ${daysSinceMeeting} jour(s)` : ''
    return `Bon engagement${meetingStr}.`
  }
  if (score >= 40) {
    const ticketStr = ticketCount > 0 ? ` — ${ticketCount} ticket(s) ouvert(s).` : '.'
    return `Engagement modéré${ticketStr}`
  }
  const ticketStr = ticketCount > 0 ? `${ticketCount} ticket(s) ouvert(s)` : 'tickets non renseignés'
  const meetingStr = daysSinceMeeting !== null
    ? `, dernière réunion il y a ${daysSinceMeeting} jours`
    : ', aucune réunion récente'
  return `Faible engagement : ${ticketStr}${meetingStr}.`
}

function narrativeContract(
  contract_score: number | null,
  contract_end_date: string | null,
  billing_interval: string | null,
): string {
  if (!contract_end_date) {
    const intervalMap: Record<string, string> = { monthly: 'mensuel', annual: 'annuel' }
    const intervalStr = billing_interval ? (intervalMap[billing_interval] ?? billing_interval) : 'non précisé'
    return `Abonnement ${intervalStr}, pas de date d'échéance renseignée.`
  }

  const daysUntil = Math.floor((new Date(contract_end_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))

  if (daysUntil < 0) return `Contrat expiré depuis ${Math.abs(daysUntil)} jour(s). Action requise.`
  if (daysUntil < 30) return `Renouvellement critique : dans ${daysUntil} jour(s) (${contract_end_date}).`
  if (daysUntil < 60) return `Renouvellement imminent : dans ${daysUntil} jours (${contract_end_date}).`
  if (daysUntil < 90) return `Renouvellement dans ${daysUntil} jours — à planifier.`
  return `Contrat actif, renouvellement dans ${daysUntil} jours (${contract_end_date}).`
}
