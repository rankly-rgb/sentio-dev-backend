// ============================================================
// Connecteur Slack (Incoming Webhook)
//
// API utilisée :
//   POST {api_endpoint} (Incoming Webhook URL configurée dans Slack)
//     — Envoie un message structuré dans le channel configuré
//
// Zero-PII strict :
//   Slack ne reçoit JAMAIS d'email client. Le message contient
//   uniquement stripe_customer_id (opaque) + métriques agrégées.
//   customer_email_transit n'est PAS utilisé pour Slack.
//
// Auth : aucune (l'auth est intégrée dans l'URL du webhook Slack)
// ============================================================

import { fetchWithTimeout } from '../fetch-with-timeout.ts'
import { retryWithBackoff } from '../retry-with-backoff.ts'
import { CircuitBreaker } from '../circuit-breaker.ts'
import type { ConnectorConfig, ConnectorPayload, ConnectorResult } from './types.ts'
import { truncate } from './types.ts'

const slackCircuit = new CircuitBreaker({ name: 'slack-connector', failureThreshold: 5, resetTimeoutMs: 60000 })

function formatMessage(payload: ConnectorPayload, template?: string): string {
  if (template) {
    return template
      .replace('{{stripe_customer_id}}', payload.stripe_customer_id)
      .replace('{{segment}}', payload.segment)
      .replace('{{churn_risk}}', String(payload.churn_risk_score))
      .replace('{{mrr_eur}}', String(payload.mrr_eur))
      .replace('{{health_score}}', String(payload.health_score))
  }

  const emoji = payload.churn_risk_score >= 70 ? ':rotating_light:' : ':warning:'
  return (
    `${emoji} *Sentio — Signal de risque*\n` +
    `Compte : \`${payload.stripe_customer_id}\`\n` +
    `Segment : *${payload.segment}*${payload.segment_previous ? ` (était : ${payload.segment_previous})` : ''}\n` +
    `Churn Risk : *${payload.churn_risk_score}%* | Health : ${payload.health_score} | MRR : $${payload.mrr_eur}`
  )
}

export async function callSlack(
  payload: ConnectorPayload,
  config: ConnectorConfig,
): Promise<ConnectorResult> {
  const webhookUrl = config.api_endpoint
  if (!webhookUrl) {
    return { success: false, error_message: 'api_endpoint (Slack webhook URL) requis' }
  }

  const message = formatMessage(payload, config.message_template)

  try {
    const res = await slackCircuit.execute(() =>
      retryWithBackoff(
        () =>
          fetchWithTimeout(
            webhookUrl,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: message }),
            },
            10000,
          ),
        { maxRetries: 3, baseDelayMs: 1000 },
      )
    )

    const body = await res.text().catch(() => '')
    return {
      success: res.status >= 200 && res.status < 300,
      http_status: res.status,
      connector_response: truncate(body),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      error_message: truncate(msg),
    }
  }
}
