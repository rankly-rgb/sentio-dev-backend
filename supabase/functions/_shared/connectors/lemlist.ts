// ============================================================
// Connecteur Lemlist
//
// API utilisée :
//   POST https://api.lemlist.com/api/campaigns/{campaignId}/leads/{email}
//     — Ajoute le lead à la campagne avec variables custom
//
// Transit PII :
//   customer_email_transit est utilisé uniquement comme identifiant
//   de lead Lemlist. Il n'est JAMAIS loggé ni persisté.
//
// Header auth : Authorization: Basic base64(:{api_key})
// ============================================================

import { fetchWithTimeout } from '../fetch-with-timeout.ts'
import { retryWithBackoff } from '../retry-with-backoff.ts'
import { CircuitBreaker } from '../circuit-breaker.ts'
import type { ConnectorConfig, ConnectorPayload, ConnectorResult } from './types.ts'
import { truncate } from './types.ts'

const lemlistCircuit = new CircuitBreaker({ name: 'lemlist', failureThreshold: 5, resetTimeoutMs: 60000 })

export async function callLemlist(
  payload: ConnectorPayload,
  config: ConnectorConfig,
): Promise<ConnectorResult> {
  if (!config.template_id) {
    return { success: false, error_message: 'template_id (campaign ID) requis pour Lemlist' }
  }

  // Basic auth : base64(:<api_key>) — le username est vide pour Lemlist
  const credentials = btoa(`:${config.api_key}`)

  try {
    const res = await lemlistCircuit.execute(() =>
      retryWithBackoff(
        () =>
          fetchWithTimeout(
            // Transit PII — email dans l'URL, jamais loggé
            `https://api.lemlist.com/api/campaigns/${config.template_id}/leads/${encodeURIComponent(payload.customer_email_transit)}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${credentials}`,
              },
              body: JSON.stringify({
                // Variables custom Zero-PII (pas d'email dans le body)
                sentioSegment: payload.segment,
                sentioChurnRisk: payload.churn_risk_score,
                sentioMrrEur: payload.mrr_eur,
                sentioHealthScore: payload.health_score,
                sentioStripeId: payload.stripe_customer_id,
              }),
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
