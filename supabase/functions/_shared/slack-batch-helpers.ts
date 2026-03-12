// ============================================================
// Slack Batch Helpers — Fonctions pures pour les digests Slack
// Extraites pour testabilité (pas d'imports Deno/jsr)
// ============================================================

/** Représente une alerte de churn critique pour un compte. */
export interface ChurnAlert {
  account_id: string
  stripe_customer_id: string
  churn_risk: number
  mrr_cents: number
  trigger_reason: string
}

/**
 * Formate le MRR en euros depuis les centimes.
 * Ex: 49900 → "499"
 */
export function formatMrrEur(mrrCents: number): string {
  return (mrrCents / 100).toFixed(0)
}

/**
 * Construit l'URL frontend vers la page compte.
 * Retourne une chaîne vide si frontendUrl est absent.
 */
export function buildAccountLink(frontendUrl: string, accountId: string): string {
  if (!frontendUrl) return ''
  return `${frontendUrl}/dashboard/accounts/${accountId}`
}

/**
 * Construit un message Slack simple (1 alerte).
 * Format : "🚨 Compte en danger critique: {stripe_customer_id} | Churn: {churn_risk}% | MRR: {mrr_eur}€ | {trigger_reason} | {link}"
 */
export function buildSingleAlertMessage(alert: ChurnAlert, frontendUrl: string): string {
  const link = buildAccountLink(frontendUrl, alert.account_id)
  const mrrEur = formatMrrEur(alert.mrr_cents)
  const parts = [
    `🚨 Compte en danger critique: ${alert.stripe_customer_id}`,
    `Churn: ${alert.churn_risk}%`,
    `MRR: ${mrrEur}€`,
    alert.trigger_reason,
  ]
  if (link) parts.push(link)
  return parts.join(' | ')
}

/**
 * Construit un message digest Slack pour N alertes (N > 1).
 * Trie par MRR décroissant, affiche les top maxItems entrées,
 * puis indique les entrées restantes si applicable.
 */
export function buildDigestMessage(alerts: ChurnAlert[], frontendUrl: string, maxItems = 10): string {
  // Tri MRR décroissant (copie pour ne pas muter l'original)
  const sorted = alerts.slice().sort((a, b) => b.mrr_cents - a.mrr_cents)
  const topItems = sorted.slice(0, maxItems)
  const remaining = sorted.length - topItems.length

  const lines: string[] = [
    `🚨 ${alerts.length} comptes en danger critique`,
  ]

  for (const alert of topItems) {
    const link = buildAccountLink(frontendUrl, alert.account_id)
    const mrrEur = formatMrrEur(alert.mrr_cents)
    const row = `• ${alert.stripe_customer_id} | Churn: ${alert.churn_risk}% | MRR: ${mrrEur}€ | ${alert.trigger_reason}${link ? ` | ${link}` : ''}`
    lines.push(row)
  }

  if (remaining > 0) {
    lines.push(`et ${remaining} autres comptes`)
  }

  return lines.join('\n')
}
