// ============================================================
// Connecteur Brevo (ex-Sendinblue)
//
// API utilisée :
//   POST https://api.brevo.com/v3/contacts
//     — Crée ou met à jour le contact avec attributs custom
//       SENTIO_SEGMENT, SENTIO_CHURN_RISK, SENTIO_MRR
//   POST https://api.brevo.com/v3/contacts/lists/{listId}/contacts/add
//     — Ajoute le contact à la liste si template_id configuré
//
// Transit PII :
//   customer_email_transit est utilisé uniquement pour identifier
//   le contact Brevo. Il n'est JAMAIS loggé ni persisté.
//
// Header auth : api-key: {api_key}
// ============================================================

import { fetchWithTimeout } from '../fetch-with-timeout.ts'
import { retryWithBackoff } from '../retry-with-backoff.ts'
import { CircuitBreaker } from '../circuit-breaker.ts'
import type { ConnectorConfig, ConnectorPayload, ConnectorResult } from './types.ts'
import { truncate } from './types.ts'

const brevoCircuit = new CircuitBreaker({ name: 'brevo', failureThreshold: 5, resetTimeoutMs: 60000 })

export async function callBrevo(
  payload: ConnectorPayload,
  config: ConnectorConfig,
): Promise<ConnectorResult> {
  const headers = {
    'Content-Type': 'application/json',
    'api-key': config.api_key,
  }

  try {
    // Étape 1 : upsert contact avec attributs Sentio
    const upsertRes = await brevoCircuit.execute(() =>
      retryWithBackoff(
        () =>
          fetchWithTimeout(
            'https://api.brevo.com/v3/contacts',
            {
              method: 'POST',
              headers,
              body: JSON.stringify({
                // Transit PII — jamais loggé
                email: payload.customer_email_transit,
                updateEnabled: true,
                attributes: {
                  SENTIO_SEGMENT: payload.segment,
                  SENTIO_CHURN_RISK: payload.churn_risk_score,
                  SENTIO_MRR: payload.mrr_eur,
                  SENTIO_HEALTH: payload.health_score,
                },
              }),
            },
            10000,
          ),
        { maxRetries: 3, baseDelayMs: 1000 },
      )
    )

    if (!upsertRes.ok) {
      const body = await upsertRes.text().catch(() => '')
      return { success: false, http_status: upsertRes.status, connector_response: truncate(body) }
    }

    // Étape 2 : ajout à la liste si template_id configuré
    if (config.template_id) {
      const listRes = await brevoCircuit.execute(() =>
        retryWithBackoff(
          () =>
            fetchWithTimeout(
              `https://api.brevo.com/v3/contacts/lists/${config.template_id}/contacts/add`,
              {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  emails: [payload.customer_email_transit],
                }),
              },
              10000,
            ),
          { maxRetries: 3, baseDelayMs: 1000 },
        )
      )

      const listBody = await listRes.text().catch(() => '')
      return {
        success: listRes.status >= 200 && listRes.status < 300,
        http_status: listRes.status,
        connector_response: truncate(listBody),
      }
    }

    return { success: true, http_status: 200, connector_response: 'contact upserted' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      error_message: truncate(msg),
    }
  }
}
