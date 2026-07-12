import { describe, it, expect } from 'vitest'

// ── Fonction miroir (score-feedback/index.ts) ──────────────────

interface ScoreFeedbackBody {
  account_id: string
  insight_id: string | null
  is_helpful: boolean
}

type ValidationResult =
  | { valid: true; data: ScoreFeedbackBody }
  | { valid: false; error: string }

function validateScoreFeedbackBody(body: unknown): ValidationResult {
  if (body === null || typeof body !== 'object') {
    return { valid: false, error: 'Body must be an object' }
  }

  const b = body as Record<string, unknown>

  if (typeof b.account_id !== 'string' || b.account_id.trim() === '') {
    return { valid: false, error: 'account_id is required' }
  }

  if (typeof b.is_helpful !== 'boolean') {
    return { valid: false, error: 'is_helpful must be a boolean' }
  }

  if (b.insight_id !== undefined && b.insight_id !== null && typeof b.insight_id !== 'string') {
    return { valid: false, error: 'insight_id must be a string if provided' }
  }

  return {
    valid: true,
    data: {
      account_id: b.account_id,
      insight_id: (b.insight_id as string | undefined) ?? null,
      is_helpful: b.is_helpful,
    },
  }
}

// ── Tests ────────────────────────────────────────────────────

describe('score-feedback: validateScoreFeedbackBody', () => {
  it('accepte un body valide avec insight_id', () => {
    const result = validateScoreFeedbackBody({ account_id: 'a1', insight_id: 'i1', is_helpful: true })
    expect(result.valid).toBe(true)
    expect(result).toMatchObject({ data: { account_id: 'a1', insight_id: 'i1', is_helpful: true } })
  })

  it('accepte un body valide sans insight_id (nullable)', () => {
    const result = validateScoreFeedbackBody({ account_id: 'a1', is_helpful: false })
    expect(result.valid).toBe(true)
    expect(result).toMatchObject({ data: { account_id: 'a1', insight_id: null, is_helpful: false } })
  })

  it('rejette un account_id manquant', () => {
    const result = validateScoreFeedbackBody({ is_helpful: true })
    expect(result).toMatchObject({ valid: false, error: 'account_id is required' })
  })

  it('rejette un account_id vide', () => {
    const result = validateScoreFeedbackBody({ account_id: '   ', is_helpful: true })
    expect(result).toMatchObject({ valid: false, error: 'account_id is required' })
  })

  it('rejette is_helpful absent', () => {
    const result = validateScoreFeedbackBody({ account_id: 'a1' })
    expect(result).toMatchObject({ valid: false, error: 'is_helpful must be a boolean' })
  })

  it('rejette is_helpful qui n\'est pas un booléen', () => {
    const result = validateScoreFeedbackBody({ account_id: 'a1', is_helpful: 'yes' })
    expect(result).toMatchObject({ valid: false, error: 'is_helpful must be a boolean' })
  })

  it('rejette insight_id qui n\'est pas une string', () => {
    const result = validateScoreFeedbackBody({ account_id: 'a1', is_helpful: true, insight_id: 42 })
    expect(result).toMatchObject({ valid: false, error: 'insight_id must be a string if provided' })
  })

  it('rejette un body null', () => {
    const result = validateScoreFeedbackBody(null)
    expect(result).toMatchObject({ valid: false, error: 'Body must be an object' })
  })

  it('rejette une string comme body', () => {
    expect(validateScoreFeedbackBody('foo')).toMatchObject({ valid: false, error: 'Body must be an object' })
  })

  it('rejette un array (typeof "object" mais sans account_id valide)', () => {
    expect(validateScoreFeedbackBody([1, 2, 3])).toMatchObject({ valid: false, error: 'account_id is required' })
  })
})
