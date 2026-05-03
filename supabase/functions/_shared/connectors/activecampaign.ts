// ============================================================
// Connecteur ActiveCampaign
//
// API utilisée :
//   POST {api_endpoint}/api/3/contacts
//     — Upsert contact (crée ou met à jour par email)
//   POST {api_endpoint}/api/3/contactAutomations
//     — Enrôle le contact dans l'automation si template_id configuré
//
// Transit PII :
//   customer_email_transit est utilisé uniquement pour identifier
//   le contact ActiveCampaign. Il n'est JAMAIS loggé ni persisté.
//
// Header auth : Api-Token: {api_key}
// ============================================================

import { fetchWithTimeout } from '../fetch-with-timeout.ts'
import { retryWithBackoff } from '../retry-with-backoff.ts'
import { CircuitBreaker } from '../circuit-breaker.ts'
import type { ConnectorConfig, ConnectorPayload, ConnectorResult } from './types.ts'
import { truncate } from './types.ts'

const acCircuit = new CircuitBreaker({ name: 'activecampaign', failureThreshold: 5, resetTimeoutMs: 60000 })

export async function callActiveCampaign(
  payload: ConnectorPayload,
  config: ConnectorConfig,
): Promise<ConnectorResult> {
  if (!config.api_endpoint) {
    return { success: false, error_message: 'api_endpoint requis pour ActiveCampaign' }
  }

  const base = config.api_endpoint.replace(/\/$/, '')
  const headers = {
    'Content-Type': 'application/json',
    'Api-Token': config.api_key,
  }

  try {
    // Étape 1 : upsert contact
    const contactRes = await acCircuit.execute(() =>
      retryWithBackoff(
        () =>
          fetchWithTimeout(
            `${base}/api/3/contacts`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({
                contact: {
                  // Transit PII — jamais loggé
                  email: payload.customer_email_transit,
                  fieldValues: [
                    { field: 'SENTIO_SEGMENT', value: payload.segment },
                    { field: 'SENTIO_CHURN_RISK', value: String(payload.churn_risk_score) },
                    { field: 'SENTIO_MRR_EUR', value: String(payload.mrr_eur) },
                  ],
                },
              }),
            },
            10000,
          ),
        { maxRetries: 3, baseDelayMs: 1000 },
      )
    )

    if (!contactRes.ok) {
      const body = await contactRes.text().catch(() => '')
      return { success: false, http_status: contactRes.status, connector_response: truncate(body) }
    }

    const contactData = await contactRes.json().catch(() => ({ contact: { id: null } }))
    const contactId: string | null = contactData?.contact?.id ?? null

    // Étape 2 : enrôlement automation si template_id et contact créé
    if (config.template_id && contactId) {
      const autoRes = await acCircuit.execute(() =>
        retryWithBackoff(
          () =>
            fetchWithTimeout(
              `${base}/api/3/contactAutomations`,
              {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  contactAutomation: {
                    contact: contactId,
                    automation: config.template_id,
                  },
                }),
              },
              10000,
            ),
          { maxRetries: 3, baseDelayMs: 1000 },
        )
      )

      const autoBody = await autoRes.text().catch(() => '')
      return {
        success: autoRes.status >= 200 && autoRes.status < 300,
        http_status: autoRes.status,
        connector_response: truncate(autoBody),
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
