import { describe, it, expect } from 'vitest'
import {
  buildHubSpotTaskBody,
  buildAssociationBody,
  parseHubSpotTaskId,
  type HubSpotTaskInput,
} from '../functions/_shared/hubspot-actions-helpers'

// ── Test fixtures ────────────────────────────────────────────

const FIXED_NOW_MS = 1710000000000 // Fixed timestamp for deterministic tests
const ONE_DAY_MS = 24 * 60 * 60 * 1000

const TASK_INPUT: HubSpotTaskInput = {
  title: 'Relance compte a risque',
  body: 'Churn: 84% | MRR: 499 EUR | Renouvellement dans 28 jours',
  dueDays: 3,
}

// ── buildHubSpotTaskBody ─────────────────────────────────────

describe('buildHubSpotTaskBody', () => {
  it('should build correct properties with title, body, type, priority', () => {
    const result = buildHubSpotTaskBody(TASK_INPUT, FIXED_NOW_MS)

    expect(result.properties.hs_task_subject).toBe('Relance compte a risque')
    expect(result.properties.hs_task_body).toBe('Churn: 84% | MRR: 499 EUR | Renouvellement dans 28 jours')
    expect(result.properties.hs_task_type).toBe('TODO')
    expect(result.properties.hs_task_priority).toBe('HIGH')
  })

  it('should set hs_timestamp to now + dueDays in milliseconds', () => {
    const result = buildHubSpotTaskBody(TASK_INPUT, FIXED_NOW_MS)
    const expectedTimestamp = FIXED_NOW_MS + (3 * ONE_DAY_MS)

    expect(result.properties.hs_timestamp).toBe(expectedTimestamp)
  })

  it('should compute hs_timestamp within 5s tolerance when nowMs not provided', () => {
    const before = Date.now()
    const result = buildHubSpotTaskBody({ ...TASK_INPUT, dueDays: 1 })
    const after = Date.now()

    const ts = result.properties.hs_timestamp as number
    expect(ts).toBeGreaterThanOrEqual(before + ONE_DAY_MS)
    expect(ts).toBeLessThanOrEqual(after + ONE_DAY_MS + 5000)
  })

  it('should default title to "Tache Sentio" when empty', () => {
    const result = buildHubSpotTaskBody(
      { title: '', body: 'test', dueDays: 1 },
      FIXED_NOW_MS,
    )

    expect(result.properties.hs_task_subject).toBe('Tache Sentio')
  })

  it('should default body to empty string when empty', () => {
    const result = buildHubSpotTaskBody(
      { title: 'Test', body: '', dueDays: 1 },
      FIXED_NOW_MS,
    )

    expect(result.properties.hs_task_body).toBe('')
  })

  it('should handle dueDays = 0 (due immediately)', () => {
    const result = buildHubSpotTaskBody(
      { title: 'Urgent', body: '', dueDays: 0 },
      FIXED_NOW_MS,
    )

    expect(result.properties.hs_timestamp).toBe(FIXED_NOW_MS)
  })

  it('should handle large dueDays value', () => {
    const result = buildHubSpotTaskBody(
      { title: 'Later', body: '', dueDays: 30 },
      FIXED_NOW_MS,
    )

    expect(result.properties.hs_timestamp).toBe(FIXED_NOW_MS + (30 * ONE_DAY_MS))
  })
})

// ── buildAssociationBody ─────────────────────────────────────

describe('buildAssociationBody', () => {
  it('should build correct inputs structure with from/to/types', () => {
    const result = buildAssociationBody('task-123', 'company-456')

    expect(result.inputs).toHaveLength(1)
    expect(result.inputs[0].from.id).toBe('task-123')
    expect(result.inputs[0].to.id).toBe('company-456')
  })

  it('should use associationTypeId 204 (task_to_company)', () => {
    const result = buildAssociationBody('task-123', 'company-456')

    expect(result.inputs[0].types).toHaveLength(1)
    expect(result.inputs[0].types[0].associationTypeId).toBe(204)
    expect(result.inputs[0].types[0].associationCategory).toBe('HUBSPOT_DEFINED')
  })

  it('should preserve exact IDs without transformation', () => {
    const result = buildAssociationBody('12345678', '87654321')

    expect(result.inputs[0].from.id).toBe('12345678')
    expect(result.inputs[0].to.id).toBe('87654321')
  })
})

// ── parseHubSpotTaskId ───────────────────────────────────────

describe('parseHubSpotTaskId', () => {
  it('should extract task ID from valid HubSpot response', () => {
    const response = {
      id: '98765',
      properties: { hs_task_subject: 'Test' },
      createdAt: '2026-03-12T00:00:00Z',
    }

    expect(parseHubSpotTaskId(response)).toBe('98765')
  })

  it('should return null for null response', () => {
    expect(parseHubSpotTaskId(null)).toBeNull()
  })

  it('should return null for undefined response', () => {
    expect(parseHubSpotTaskId(undefined)).toBeNull()
  })

  it('should return null when id field is missing', () => {
    expect(parseHubSpotTaskId({ properties: {} })).toBeNull()
  })

  it('should return null when id is not a string', () => {
    expect(parseHubSpotTaskId({ id: 12345 })).toBeNull()
  })

  it('should return null for non-object response', () => {
    expect(parseHubSpotTaskId('string-response')).toBeNull()
  })

  it('should return null for array response', () => {
    expect(parseHubSpotTaskId([{ id: '123' }])).toBeNull()
  })
})
