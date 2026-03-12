import { fetchWithTimeout } from './fetch-with-timeout.ts'
import {
  type ChurnAlert,
  buildSingleAlertMessage,
  buildDigestMessage,
} from './slack-batch-helpers.ts'

export async function alertSlack(
  message: string,
  opts?: { level?: 'info' | 'warning' | 'critical' }
): Promise<void> {
  const url = Deno.env.get('SLACK_WEBHOOK_URL')
  if (!url) return

  const level = opts?.level ?? 'info'
  const prefix =
    level === 'critical' ? '[CRITICAL]' : level === 'warning' ? '[WARNING]' : '[INFO]'

  try {
    await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `${prefix} [Sentio] ${message}` }),
      },
      5000
    )
  } catch {
    // Fire-and-forget: alerting failure must never crash the caller
  }
}

/**
 * Envoie un digest Slack groupé pour les alertes de churn critique.
 *
 * - 0 alertes → no-op
 * - 1 alerte  → message simple (pas de digest)
 * - N > 1     → un seul message digest trié par MRR décroissant
 *
 * Fire-and-forget : ne throw jamais, toutes les erreurs sont avalées silencieusement.
 */
export async function alertSlackBatch(
  alerts: ChurnAlert[],
  maxItems = 10
): Promise<void> {
  try {
    if (alerts.length === 0) return

    const url = Deno.env.get('SLACK_WEBHOOK_URL')
    if (!url) return

    const frontendUrl = Deno.env.get('FRONTEND_URL') ?? ''

    const text =
      alerts.length === 1
        ? buildSingleAlertMessage(alerts[0], frontendUrl)
        : buildDigestMessage(alerts, frontendUrl, maxItems)

    await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      },
      5000
    )
  } catch {
    // Fire-and-forget: alerting failure must never crash the caller
  }
}
