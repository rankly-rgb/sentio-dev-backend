// ============================================================
// Connecteur HubSpot (mode email)
//
// Distinct de _shared/hubspot-client.ts qui opère sur les companies.
// Ce connecteur opère sur les contacts via email en transit.
//
// API utilisée :
//   POST https://api.hubapi.com/crm/v3/objects/contacts/search
//     — Recherche le contact par email (transit)
//   POST https://api.hubapi.com/crm/v3/objects/contacts
//     — Crée le contact s'il n'existe pas
//   POST https://api.hubapi.com/automation/v4/sequences/{seqId}/enrollments
//     — Enrôle le contact dans la séquence si template_id configuré
//   PATCH https://api.hubapi.com/crm/v3/objects/contacts/{id}
//     — Met à jour les propriétés Sentio du contact
//
// Transit PII :
//   customer_email_transit est utilisé uniquement pour identifier
//   le contact HubSpot. Il n'est JAMAIS loggé ni persisté.
//
// Header auth : Authorization: Bearer {api_key}
// ============================================================

import { fetchWithTimeout } from '../fetch-with-timeout.ts'
import { retryWithBackoff } from '../retry-with-backoff.ts'
import { CircuitBreaker } from '../circuit-breaker.ts'
import type { ConnectorConfig, ConnectorPayload, ConnectorResult } from './types.ts'
import { truncate } from './types.ts'

const hubspotCircuit = new CircuitBreaker({ name: 'hubspot-connector', failureThreshold: 5, resetTimeoutMs: 60000 })

const HS_BASE = 'https://api.hubapi.com'

export async function callHubspot(
  payload: ConnectorPayload,
  config: ConnectorConfig,
): Promise<ConnectorResult> {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.api_key}`,
  }

  try {
    // Étape 1 : rechercher le contact par email (transit)
    const searchRes = await hubspotCircuit.execute(() =>
      retryWithBackoff(
        () =>
          fetchWithTimeout(
            `${HS_BASE}/crm/v3/objects/contacts/search`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({
                filterGroups: [{
                  filters: [{
                    propertyName: 'email',
                    operator: 'EQ',
                    // Transit PII — jamais loggé
                    value: payload.customer_email_transit,
                  }],
                }],
                properties: ['id', 'email'],
                limit: 1,
              }),
            },
            10000,
          ),
        { maxRetries: 3, baseDelayMs: 1000 },
      )
    )

    if (!searchRes.ok) {
      const body = await searchRes.text().catch(() => '')
      return { success: false, http_status: searchRes.status, connector_response: truncate(body) }
    }

    const searchData = await searchRes.json()
    let contactId: string | null = searchData?.results?.[0]?.id ?? null

    // Étape 2 : créer le contact s'il n'existe pas
    if (!contactId) {
      const createRes = await hubspotCircuit.execute(() =>
        retryWithBackoff(
          () =>
            fetchWithTimeout(
              `${HS_BASE}/crm/v3/objects/contacts`,
              {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  properties: {
                    email: payload.customer_email_transit,
                    sentio_segment: payload.segment,
                    sentio_churn_risk: String(payload.churn_risk_score),
                    sentio_mrr_eur: String(payload.mrr_eur),
                  },
                }),
              },
              10000,
            ),
          { maxRetries: 2, baseDelayMs: 1000 },
        )
      )

      if (!createRes.ok) {
        const body = await createRes.text().catch(() => '')
        return { success: false, http_status: createRes.status, connector_response: truncate(body) }
      }

      const createData = await createRes.json()
      contactId = createData?.id ?? null
    } else {
      // Mettre à jour les propriétés Sentio
      await hubspotCircuit.execute(() =>
        retryWithBackoff(
          () =>
            fetchWithTimeout(
              `${HS_BASE}/crm/v3/objects/contacts/${contactId}`,
              {
                method: 'PATCH',
                headers,
                body: JSON.stringify({
                  properties: {
                    sentio_segment: payload.segment,
                    sentio_churn_risk: String(payload.churn_risk_score),
                    sentio_mrr_eur: String(payload.mrr_eur),
                  },
                }),
              },
              10000,
            ),
          { maxRetries: 2, baseDelayMs: 1000 },
        )
      ).catch(() => null)
    }

    // Étape 3 : enrôlement séquence si template_id configuré
    if (config.template_id && contactId) {
      const enrollRes = await hubspotCircuit.execute(() =>
        retryWithBackoff(
          () =>
            fetchWithTimeout(
              `${HS_BASE}/automation/v4/sequences/${config.template_id}/enrollments`,
              {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  contactId,
                  senderId: null,
                }),
              },
              10000,
            ),
          { maxRetries: 2, baseDelayMs: 1000 },
        )
      )

      const enrollBody = await enrollRes.text().catch(() => '')
      return {
        success: enrollRes.status >= 200 && enrollRes.status < 300,
        http_status: enrollRes.status,
        connector_response: truncate(enrollBody),
      }
    }

    return { success: true, http_status: 200, connector_response: 'contact updated' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      error_message: truncate(msg),
    }
  }
}
