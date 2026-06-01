// ============================================================
// HubSpot API Client — Zero-PII
// Enrôlement séquence et mise à jour propriétés company
// Rate limit : 5 appels/sec (300/min, safe under HubSpot standard tier)
// ============================================================

import { fetchWithTimeout } from './fetch-with-timeout.ts'
import { retryWithBackoff } from './retry-with-backoff.ts'

const HUBSPOT_BASE_URL = 'https://api.hubapi.com'
const TIMEOUT_MS = 10000

// ── Rate limiter token bucket (per Edge Function instance) ──

class RateLimiter {
  private tokens: number
  private lastRefillMs: number
  private readonly maxTokens: number
  private readonly refillRatePerMs: number

  constructor(callsPerSecond: number) {
    this.maxTokens = callsPerSecond
    this.refillRatePerMs = callsPerSecond / 1000
    this.tokens = callsPerSecond
    this.lastRefillMs = Date.now()
  }

  async waitForToken(): Promise<void> {
    const now = Date.now()
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + (now - this.lastRefillMs) * this.refillRatePerMs,
    )
    this.lastRefillMs = now

    if (this.tokens >= 1) {
      this.tokens -= 1
      return
    }

    const waitMs = Math.ceil((1 - this.tokens) / this.refillRatePerMs)
    await new Promise((r) => setTimeout(r, waitMs))
    this.tokens = 0
    this.lastRefillMs = Date.now()
  }
}

// 3/sec (vs. HubSpot standard 10/sec) pour laisser de la marge si plusieurs instances Deno tournent en parallèle
export const hubspotRateLimiter = new RateLimiter(3)

// ── Types ────────────────────────────────────────────────────

export interface HubSpotResult {
  success: boolean
  status?: number
  error?: string
}

export interface HubSpotTaskResult extends HubSpotResult {
  taskId?: string
}

// ── Helpers ──────────────────────────────────────────────────

function getApiKey(override?: string): string {
  const key = override ?? Deno.env.get('HUBSPOT_API_KEY')
  if (!key) throw new Error('HUBSPOT_API_KEY not configured')
  return key
}

function hubspotHeaders(apiKey?: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${getApiKey(apiKey)}`,
    'Content-Type': 'application/json',
  }
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message
  return msg.includes('timed out') || msg.includes('429') || msg.includes('503') || msg.includes('502')
}

// ── API calls ────────────────────────────────────────────────

/**
 * Récupère les contact IDs HubSpot associés à une company.
 * Retourne [] si la company n'existe pas (404).
 */
export async function getCompanyContacts(companyId: string, apiKey?: string): Promise<string[]> {
  const response = await retryWithBackoff(
    async () => {
      await hubspotRateLimiter.waitForToken()
      const res = await fetchWithTimeout(
        `${HUBSPOT_BASE_URL}/crm/v3/objects/companies/${companyId}/associations/contacts`,
        { headers: hubspotHeaders(apiKey) },
        TIMEOUT_MS,
      )
      if (res.status === 429) throw new Error('HubSpot rate limit (429)')
      return res
    },
    { maxRetries: 2, retryOn: isTransient },
  )

  if (response.status === 404) return []
  if (!response.ok) {
    throw new Error(`HubSpot getCompanyContacts HTTP ${response.status}`)
  }

  const data = await response.json() as { results: Array<{ id: string }> }
  return (data.results ?? []).map((r) => r.id)
}

/**
 * Récupère les contact IDs HubSpot pour un lot de companies en 1-2 appels API.
 * Utilise POST /crm/v3/associations/company/contact/batch/read (max 100 par requête).
 * Les companies absentes de la Map retournée n'ont pas pu être récupérées → fallback individuel.
 */
export async function getBatchCompanyContacts(
  companyIds: string[],
  apiKey?: string,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (companyIds.length === 0) return result

  const BATCH_SIZE = 100

  for (let i = 0; i < companyIds.length; i += BATCH_SIZE) {
    const chunk = companyIds.slice(i, i + BATCH_SIZE)

    try {
      const response = await retryWithBackoff(
        async () => {
          await hubspotRateLimiter.waitForToken()
          const res = await fetchWithTimeout(
            `${HUBSPOT_BASE_URL}/crm/v3/associations/company/contact/batch/read`,
            {
              method: 'POST',
              headers: hubspotHeaders(apiKey),
              body: JSON.stringify({ inputs: chunk.map((id) => ({ id })) }),
            },
            TIMEOUT_MS,
          )
          if (res.status === 429) throw new Error('HubSpot rate limit (429)')
          return res
        },
        { maxRetries: 2, retryOn: isTransient },
      )

      if (!response.ok) continue

      const data = await response.json() as {
        results: Array<{ from: { id: string }; to: Array<{ id: string }> }>
      }

      // Toutes les companies du chunk sont marquées (0 contacts par défaut)
      for (const id of chunk) result.set(id, [])

      // Surcharger avec les contacts réels
      for (const entry of data.results ?? []) {
        result.set(entry.from.id, (entry.to ?? []).map((t) => t.id))
      }
    } catch {
      // Chunk échoué — les entrées restent absentes → fallback individuel dans dispatchAction
    }
  }

  return result
}

/**
 * Enrôle un contact dans une séquence HubSpot.
 * senderId = HubSpot user ID de l'expéditeur (requis par l'API).
 */
export async function enrollInSequence(
  contactId: string,
  sequenceId: string,
  senderId: string,
  apiKey?: string,
): Promise<HubSpotResult> {
  try {
    const response = await retryWithBackoff(
      async () => {
        await hubspotRateLimiter.waitForToken()
        const res = await fetchWithTimeout(
          `${HUBSPOT_BASE_URL}/automation/v4/sequences/${sequenceId}/enrollments`,
          {
            method: 'POST',
            headers: hubspotHeaders(apiKey),
            body: JSON.stringify({ contactId, senderId }),
          },
          TIMEOUT_MS,
        )
        if (res.status === 429) throw new Error('HubSpot rate limit (429)')
        return res
      },
      { maxRetries: 2, retryOn: isTransient },
    )

    if (response.ok || response.status === 204) {
      return { success: true, status: response.status }
    }

    const body = await response.text()
    console.error(JSON.stringify({
      level: 'error',
      module: 'hubspot-client',
      fn: 'enrollInSequence',
      status: response.status,
      sequenceId,
      contactId,
      error: body.slice(0, 500),
    }))
    return { success: false, status: response.status, error: body.slice(0, 200) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({
      level: 'error',
      module: 'hubspot-client',
      fn: 'enrollInSequence',
      sequenceId,
      contactId,
      error: msg,
    }))
    return { success: false, error: msg }
  }
}

/**
 * Crée une tâche CRM HubSpot (type TODO).
 * Retourne le taskId créé en cas de succès.
 * Zero-PII : sujet et corps ne contiennent jamais d'email/nom de contact.
 */
export async function createTask(
  subject: string,
  body: string,
  priority: 'HIGH' | 'MEDIUM' | 'LOW',
  apiKey?: string,
  ownerId?: string,
): Promise<HubSpotTaskResult> {
  try {
    const properties: Record<string, string> = {
      hs_task_subject:  subject,
      hs_task_body:     body,
      hs_task_status:   'NOT_STARTED',
      hs_task_priority: priority,
      hs_task_type:     'TODO',
      hs_timestamp:     String(Date.now()),
    }
    if (ownerId) properties.hs_task_owner_id = ownerId

    const response = await retryWithBackoff(
      async () => {
        await hubspotRateLimiter.waitForToken()
        const res = await fetchWithTimeout(
          `${HUBSPOT_BASE_URL}/crm/v3/objects/tasks`,
          {
            method: 'POST',
            headers: hubspotHeaders(apiKey),
            body: JSON.stringify({ properties }),
          },
          TIMEOUT_MS,
        )
        if (res.status === 429) throw new Error('HubSpot rate limit (429)')
        return res
      },
      { maxRetries: 2, retryOn: isTransient },
    )

    if (response.status === 201) {
      const data = await response.json() as { id: string }
      return { success: true, status: 201, taskId: data.id }
    }

    const errBody = await response.text()
    console.error(JSON.stringify({
      level: 'error', module: 'hubspot-client', fn: 'createTask',
      status: response.status, error: errBody.slice(0, 500),
    }))
    return { success: false, status: response.status, error: errBody.slice(0, 200) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', module: 'hubspot-client', fn: 'createTask', error: msg }))
    return { success: false, error: msg }
  }
}

/**
 * Associe une tâche HubSpot à une company via batch v3.
 * Testé et validé sur EU1 (POST /crm/v3/associations/tasks/companies/batch/create → 201).
 * Non-bloquant : un échec doit être loggué mais ne doit pas faire échouer l'action.
 */
export async function associateTaskToCompany(
  taskId: string,
  companyId: string,
  apiKey?: string,
): Promise<HubSpotResult> {
  await hubspotRateLimiter.waitForToken()
  try {
    const res = await fetchWithTimeout(
      `${HUBSPOT_BASE_URL}/crm/v3/associations/tasks/companies/batch/create`,
      {
        method: 'POST',
        headers: hubspotHeaders(apiKey),
        body: JSON.stringify({
          inputs: [{ from: { id: taskId }, to: { id: companyId }, type: 'task_to_company' }],
        }),
      },
      TIMEOUT_MS,
    )
    if (res.ok || res.status === 201) return { success: true, status: res.status }
    const b = await res.text()
    return { success: false, status: res.status, error: b.slice(0, 200) }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Lit les propriétés d'une company HubSpot.
 * Retourne un objet { prop: value | null }. Retourne {} si la company n'existe pas.
 */
export async function getCompanyProperties(
  companyId: string,
  properties: string[],
  apiKey?: string,
): Promise<Record<string, string | null>> {
  try {
    await hubspotRateLimiter.waitForToken()
    const res = await fetchWithTimeout(
      `${HUBSPOT_BASE_URL}/crm/v3/objects/companies/${companyId}?properties=${properties.join(',')}`,
      { headers: hubspotHeaders(apiKey) },
      TIMEOUT_MS,
    )
    if (res.status === 404) return {}
    if (!res.ok) return {}
    const data = await res.json() as { properties: Record<string, string | null> }
    return data.properties ?? {}
  } catch {
    return {}
  }
}

/**
 * Met à jour les propriétés d'une company HubSpot (PATCH).
 * Utilisé pour marquer un compte "at_risk", ajouter un tag, etc.
 */
export async function updateCompanyProperties(
  companyId: string,
  properties: Record<string, unknown>,
  apiKey?: string,
): Promise<HubSpotResult> {
  try {
    const response = await retryWithBackoff(
      async () => {
        await hubspotRateLimiter.waitForToken()
        const res = await fetchWithTimeout(
          `${HUBSPOT_BASE_URL}/crm/v3/objects/companies/${companyId}`,
          {
            method: 'PATCH',
            headers: hubspotHeaders(apiKey),
            body: JSON.stringify({ properties }),
          },
          TIMEOUT_MS,
        )
        if (res.status === 429) throw new Error('HubSpot rate limit (429)')
        return res
      },
      { maxRetries: 2, retryOn: isTransient },
    )

    if (response.ok) return { success: true, status: response.status }

    const body = await response.text()
    return { success: false, status: response.status, error: body.slice(0, 200) }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
