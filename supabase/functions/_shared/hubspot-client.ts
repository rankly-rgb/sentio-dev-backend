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

export const hubspotRateLimiter = new RateLimiter(5)

// ── Types ────────────────────────────────────────────────────

export interface HubSpotResult {
  success: boolean
  status?: number
  error?: string
}

// ── Helpers ──────────────────────────────────────────────────

function getApiKey(): string {
  const key = Deno.env.get('HUBSPOT_API_KEY')
  if (!key) throw new Error('HUBSPOT_API_KEY not configured')
  return key
}

function hubspotHeaders(): Record<string, string> {
  return {
    'Authorization': `Bearer ${getApiKey()}`,
    'Content-Type': 'application/json',
  }
}

function isTransient(err: unknown): boolean {
  return err instanceof Error && err.message.includes('timed out')
}

// ── API calls ────────────────────────────────────────────────

/**
 * Récupère les contact IDs HubSpot associés à une company.
 * Retourne [] si la company n'existe pas (404).
 */
export async function getCompanyContacts(companyId: string): Promise<string[]> {
  await hubspotRateLimiter.waitForToken()

  const response = await retryWithBackoff(
    () =>
      fetchWithTimeout(
        `${HUBSPOT_BASE_URL}/crm/v3/objects/companies/${companyId}/associations/contacts`,
        { headers: hubspotHeaders() },
        TIMEOUT_MS,
      ),
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
 * Enrôle un contact dans une séquence HubSpot.
 * senderId = HubSpot user ID de l'expéditeur (requis par l'API).
 */
export async function enrollInSequence(
  contactId: string,
  sequenceId: string,
  senderId: string,
): Promise<HubSpotResult> {
  await hubspotRateLimiter.waitForToken()

  try {
    const response = await retryWithBackoff(
      () =>
        fetchWithTimeout(
          `${HUBSPOT_BASE_URL}/automation/v4/sequences/${sequenceId}/enrollments`,
          {
            method: 'POST',
            headers: hubspotHeaders(),
            body: JSON.stringify({ contactId, senderId }),
          },
          TIMEOUT_MS,
        ),
      { maxRetries: 2, retryOn: isTransient },
    )

    if (response.ok || response.status === 204) {
      return { success: true, status: response.status }
    }

    const body = await response.text()
    return { success: false, status: response.status, error: body.slice(0, 200) }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Met à jour les propriétés d'une company HubSpot (PATCH).
 * Utilisé pour marquer un compte "at_risk", ajouter un tag, etc.
 */
export async function updateCompanyProperties(
  companyId: string,
  properties: Record<string, unknown>,
): Promise<HubSpotResult> {
  await hubspotRateLimiter.waitForToken()

  try {
    const response = await retryWithBackoff(
      () =>
        fetchWithTimeout(
          `${HUBSPOT_BASE_URL}/crm/v3/objects/companies/${companyId}`,
          {
            method: 'PATCH',
            headers: hubspotHeaders(),
            body: JSON.stringify({ properties }),
          },
          TIMEOUT_MS,
        ),
      { maxRetries: 2, retryOn: isTransient },
    )

    if (response.ok) return { success: true, status: response.status }

    const body = await response.text()
    return { success: false, status: response.status, error: body.slice(0, 200) }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
