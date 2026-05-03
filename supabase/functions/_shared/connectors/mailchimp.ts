// ============================================================
// Connecteur Mailchimp
//
// API utilisée :
//   PUT https://{dc}.api.mailchimp.com/3.0/lists/{listId}/members/{md5(email)}
//     — Upsert membre avec merge fields SENTIO_SEG, SENTIO_CHURN, SENTIO_MRR
//
// Le {dc} (datacenter) est extrait du format de la clé API : <key>-<dc>
// Le hash MD5 de l'email (lowercase) est requis par l'API Mailchimp.
// Il est calculé en mémoire uniquement — jamais persisté.
//
// Transit PII :
//   customer_email_transit est utilisé uniquement pour le calcul du hash
//   et l'upsert membre. Il n'est JAMAIS loggé ni persisté.
//
// Header auth : Authorization: Basic base64(anystring:{api_key})
// ============================================================

import { fetchWithTimeout } from '../fetch-with-timeout.ts'
import { retryWithBackoff } from '../retry-with-backoff.ts'
import { CircuitBreaker } from '../circuit-breaker.ts'
import type { ConnectorConfig, ConnectorPayload, ConnectorResult } from './types.ts'
import { truncate } from './types.ts'

const mailchimpCircuit = new CircuitBreaker({ name: 'mailchimp', failureThreshold: 5, resetTimeoutMs: 60000 })

// MD5 requis par Mailchimp pour l'identifiant membre dans l'URL.
// Calculé via node:crypto (disponible dans Deno Edge Functions).
// L'email transite uniquement en mémoire — non loggé.
async function md5Hex(input: string): Promise<string> {
  // Deno supporte node:crypto pour la compatibilité
  const { createHash } = await import('node:crypto')
  return createHash('md5').update(input).digest('hex')
}

export async function callMailchimp(
  payload: ConnectorPayload,
  config: ConnectorConfig,
): Promise<ConnectorResult> {
  if (!config.template_id) {
    return { success: false, error_message: 'template_id (list ID) requis pour Mailchimp' }
  }

  // Extraire le datacenter depuis la clé API (format: <key>-<dc>)
  const dcMatch = config.api_key.match(/-([a-z0-9]+)$/)
  if (!dcMatch) {
    return { success: false, error_message: 'api_key Mailchimp invalide (format attendu: key-dc)' }
  }
  const dc = dcMatch[1]

  const credentials = btoa(`anystring:${config.api_key}`)

  try {
    // Hash MD5 de l'email lowercase — calculé en mémoire uniquement
    const emailHash = await md5Hex(payload.customer_email_transit.toLowerCase())

    const res = await mailchimpCircuit.execute(() =>
      retryWithBackoff(
        () =>
          fetchWithTimeout(
            `https://${dc}.api.mailchimp.com/3.0/lists/${config.template_id}/members/${emailHash}`,
            {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${credentials}`,
              },
              body: JSON.stringify({
                // Transit PII — email dans le body, jamais loggé
                email_address: payload.customer_email_transit,
                status_if_new: 'subscribed',
                merge_fields: {
                  SENTIO_SEG: payload.segment,
                  SENTIO_CHURN: payload.churn_risk_score,
                  SENTIO_MRR: payload.mrr_eur,
                },
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
