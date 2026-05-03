// ============================================================
// Connecteur Custom (webhook JSON générique)
//
// API utilisée :
//   POST {api_endpoint}
//     — Envoie un payload JSON Zero-PII complet vers n'importe quelle URL
//
// Zero-PII strict :
//   Le payload envoyé ne contient JAMAIS d'email, nom, téléphone ou IP.
//   customer_email_transit n'est PAS inclus dans le payload custom.
//   Uniquement stripe_customer_id (opaque) + métriques agrégées.
//
// Auth optionnelle : api_key envoyée en header Authorization si configurée
// ============================================================

import { fetchWithTimeout } from '../fetch-with-timeout.ts'
import { retryWithBackoff } from '../retry-with-backoff.ts'
import { CircuitBreaker } from '../circuit-breaker.ts'
import type { ConnectorConfig, ConnectorPayload, ConnectorResult } from './types.ts'
import { truncate } from './types.ts'

const customCircuit = new CircuitBreaker({ name: 'custom-connector', failureThreshold: 5, resetTimeoutMs: 60000 })

export async function callCustom(
  payload: ConnectorPayload,
  config: ConnectorConfig,
): Promise<ConnectorResult> {
  const endpoint = config.api_endpoint
  if (!endpoint) {
    return { success: false, error_message: 'api_endpoint requis pour le connecteur custom' }
  }

  // Payload Zero-PII — jamais d'email, nom, téléphone, IP
  const body = {
    source: 'sentio_ai',
    event: 'account_risk_detected',
    account: {
      stripe_customer_id: payload.stripe_customer_id,
      segment: payload.segment,
      segment_previous: payload.segment_previous,
      health_score: payload.health_score,
      churn_risk_score: payload.churn_risk_score,
      expansion_score: payload.expansion_score,
      mrr_cents: payload.mrr_cents,
      mrr_eur: payload.mrr_eur,
    },
    trigger_reason: payload.trigger_reason,
    triggered_at: new Date().toISOString(),
    organization_id: payload.organization_id,
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Sentio-AI/1.0',
  }

  if (config.api_key) {
    headers['Authorization'] = `Bearer ${config.api_key}`
  }

  try {
    const res = await customCircuit.execute(() =>
      retryWithBackoff(
        () =>
          fetchWithTimeout(
            endpoint,
            { method: 'POST', headers, body: JSON.stringify(body) },
            10000,
          ),
        { maxRetries: 3, baseDelayMs: 1000 },
      )
    )

    const resBody = await res.text().catch(() => '')
    return {
      success: res.status >= 200 && res.status < 300,
      http_status: res.status,
      connector_response: truncate(resBody),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      error_message: truncate(msg),
    }
  }
}
