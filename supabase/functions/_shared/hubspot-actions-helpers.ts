// ============================================================
// HubSpot Actions Helpers — Fonctions pures testables avec Vitest
// Pas d'imports Deno/jsr — construction de payloads HubSpot API
// ============================================================

/** Input for creating a HubSpot CRM task */
export interface HubSpotTaskInput {
  /** Task subject line */
  title: string
  /** Task body/description (Zero-PII: scores and identifiers only) */
  body: string
  /** Due date offset in days from now */
  dueDays: number
}

/** Result of a HubSpot task creation */
export interface HubSpotTaskResult {
  taskId: string
  associationSuccess: boolean
}

/** Association type ID for task-to-company in HubSpot v4 API */
const TASK_TO_COMPANY_ASSOCIATION_TYPE_ID = 204

/**
 * Builds the HubSpot API request body for creating a CRM task.
 * Uses the HubSpot CRM v3 objects/tasks endpoint format.
 *
 * @param input - Task input with title, body, and dueDays
 * @param nowMs - Current timestamp in ms (injectable for testing)
 * @returns Properties object for HubSpot POST /crm/v3/objects/tasks
 */
export function buildHubSpotTaskBody(
  input: HubSpotTaskInput,
  nowMs?: number,
): { properties: Record<string, string | number> } {
  const now = nowMs ?? Date.now()
  const dueTimestamp = now + (input.dueDays * 24 * 60 * 60 * 1000)

  return {
    properties: {
      hs_task_subject: input.title || 'Tache Sentio',
      hs_task_body: input.body || '',
      hs_task_type: 'TODO',
      hs_task_priority: 'HIGH',
      hs_timestamp: dueTimestamp,
    },
  }
}

/**
 * Builds the HubSpot v4 associations batch/create request body.
 * Links a task to a company using association type 204 (task_to_company).
 *
 * @param taskId - HubSpot task ID (from task creation response)
 * @param companyId - HubSpot company ID to associate with
 * @returns Request body for POST /crm/v4/associations/tasks/companies/batch/create
 */
export function buildAssociationBody(
  taskId: string,
  companyId: string,
): { inputs: Array<{ from: { id: string }; to: { id: string }; types: Array<{ associationCategory: string; associationTypeId: number }> }> } {
  return {
    inputs: [
      {
        from: { id: taskId },
        to: { id: companyId },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: TASK_TO_COMPANY_ASSOCIATION_TYPE_ID,
          },
        ],
      },
    ],
  }
}

/**
 * Extracts the task ID from a HubSpot CRM v3 task creation response.
 * Returns null if the response is invalid or missing the id field.
 *
 * @param response - Parsed JSON response from HubSpot API
 * @returns Task ID string or null
 */
export function parseHubSpotTaskId(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null
  const obj = response as Record<string, unknown>
  if (!obj.id || typeof obj.id !== 'string') return null
  return obj.id
}
