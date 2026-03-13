// ============================================================
// HubSpot Actions — CRM Task creation for playbook-execute
// Deno-compatible module (uses fetchWithTimeout for HTTP calls)
// Zero-PII: only scores, identifiers, and trigger reasons
// ============================================================

import { fetchWithTimeout } from './fetch-with-timeout.ts'
import {
  buildHubSpotTaskBody,
  buildAssociationBody,
  parseHubSpotTaskId,
  type HubSpotTaskInput,
  type HubSpotTaskResult,
} from './hubspot-actions-helpers.ts'
import {
  buildHubSpotEmailBody,
  buildEmailAssociationBody,
  parseHubSpotEmailId,
  type HubSpotEmailInput,
  type HubSpotEmailResult,
  type EmailTemplateVars,
} from './hubspot-email-helpers.ts'

// Re-export types for consumers
export type { HubSpotTaskInput, HubSpotTaskResult, HubSpotEmailInput, HubSpotEmailResult, EmailTemplateVars }

const HUBSPOT_API_BASE = 'https://api.hubapi.com'
const HUBSPOT_TIMEOUT_MS = 8000

/**
 * Creates a HubSpot CRM task via the v3 objects API.
 * Uses fetchWithTimeout (8s) for resilience.
 *
 * @param token - HubSpot access token (OAuth or Private App pat-)
 * @param input - Task details (title, body, dueDays)
 * @returns Task ID and association status
 * @throws Error on non-2xx response from HubSpot API
 */
export async function createHubSpotTask(
  token: string,
  input: HubSpotTaskInput,
): Promise<HubSpotTaskResult> {
  const body = buildHubSpotTaskBody(input)

  const response = await fetchWithTimeout(
    `${HUBSPOT_API_BASE}/crm/v3/objects/tasks`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    HUBSPOT_TIMEOUT_MS,
  )

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown')
    throw new Error(`HubSpot API error ${response.status}: ${text}`)
  }

  const json = await response.json()
  const taskId = parseHubSpotTaskId(json)

  if (!taskId) {
    throw new Error('HubSpot API returned success but task ID is missing from response')
  }

  return { taskId, associationSuccess: false }
}

/**
 * Associates a HubSpot task to a company via the v4 associations batch API.
 * Uses association type 204 (task_to_company, HUBSPOT_DEFINED).
 *
 * @param token - HubSpot access token
 * @param taskId - HubSpot task ID (from createHubSpotTask)
 * @param hubspotCompanyId - HubSpot company ID to link
 * @throws Error on non-2xx response (non-critical — caller should catch)
 */
export async function associateTaskToCompany(
  token: string,
  taskId: string,
  hubspotCompanyId: string,
): Promise<void> {
  const body = buildAssociationBody(taskId, hubspotCompanyId)

  const response = await fetchWithTimeout(
    `${HUBSPOT_API_BASE}/crm/v4/associations/tasks/companies/batch/create`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    HUBSPOT_TIMEOUT_MS,
  )

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown')
    throw new Error(`HubSpot association API error ${response.status}: ${text}`)
  }
}

/**
 * Creates a HubSpot CRM email engagement via the v3 objects API.
 * HubSpot resolves the contact from the associated company and sends the email.
 * Zero-PII: Sentio sends only scores and identifiers, never email addresses.
 *
 * @param token - HubSpot access token (OAuth or Private App pat-)
 * @param input - Email details (subject, body_html)
 * @param vars - Template variables for substitution
 * @returns Email ID and association status
 * @throws Error on non-2xx response from HubSpot API
 */
export async function sendHubSpotEmail(
  token: string,
  input: HubSpotEmailInput,
  vars: EmailTemplateVars,
): Promise<HubSpotEmailResult> {
  const body = buildHubSpotEmailBody(input, vars)

  const response = await fetchWithTimeout(
    `${HUBSPOT_API_BASE}/crm/v3/objects/emails`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    HUBSPOT_TIMEOUT_MS,
  )

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown')
    throw new Error(`HubSpot Email API error ${response.status}: ${text}`)
  }

  const json = await response.json()
  const emailId = parseHubSpotEmailId(json)

  if (!emailId) {
    throw new Error('HubSpot Email API returned success but email ID is missing from response')
  }

  return { emailId, associationSuccess: false }
}

/**
 * Associates a HubSpot email to a company via the v4 associations batch API.
 * Uses association type 186 (email_to_company, HUBSPOT_DEFINED).
 *
 * @param token - HubSpot access token
 * @param emailId - HubSpot email ID (from sendHubSpotEmail)
 * @param hubspotCompanyId - HubSpot company ID to link
 * @throws Error on non-2xx response (non-critical — caller should catch)
 */
export async function associateEmailToCompany(
  token: string,
  emailId: string,
  hubspotCompanyId: string,
): Promise<void> {
  const body = buildEmailAssociationBody(emailId, hubspotCompanyId)

  const response = await fetchWithTimeout(
    `${HUBSPOT_API_BASE}/crm/v4/associations/emails/companies/batch/create`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    HUBSPOT_TIMEOUT_MS,
  )

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown')
    throw new Error(`HubSpot email association API error ${response.status}: ${text}`)
  }
}
