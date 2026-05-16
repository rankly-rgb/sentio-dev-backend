import { describe, it, expect } from 'vitest'

// ── Fonction pure miroir (org-settings/index.ts) ─────────────

const SUPPORTED_LOCALES = ['fr', 'en'] as const
type Locale = typeof SUPPORTED_LOCALES[number]

type ParseOk = { ok: true; locale: Locale }
type ParseErr = { ok: false; error: string }

function validatePatchBody(body: unknown): ParseOk | ParseErr {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object' }
  }

  const b = body as Record<string, unknown>

  if (!('locale' in b)) {
    return { ok: false, error: 'Missing field: locale' }
  }

  if (!SUPPORTED_LOCALES.includes(b.locale as Locale)) {
    return { ok: false, error: `locale must be one of: ${SUPPORTED_LOCALES.join(', ')}` }
  }

  return { ok: true, locale: b.locale as Locale }
}

// ── Tests ──────────────────────────────────────────────────────

describe('validatePatchBody', () => {
  it('accepts fr', () => {
    const result = validatePatchBody({ locale: 'fr' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.locale).toBe('fr')
  })

  it('accepts en', () => {
    const result = validatePatchBody({ locale: 'en' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.locale).toBe('en')
  })

  it('rejects unknown locale', () => {
    const result = validatePatchBody({ locale: 'es' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/fr.*en|en.*fr/)
  })

  it('rejects missing locale field', () => {
    const result = validatePatchBody({ foo: 'bar' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/locale/)
  })

  it('rejects null body', () => {
    const result = validatePatchBody(null)
    expect(result.ok).toBe(false)
  })

  it('rejects array body', () => {
    const result = validatePatchBody([{ locale: 'fr' }])
    expect(result.ok).toBe(false)
  })

  it('rejects string body', () => {
    const result = validatePatchBody('fr')
    expect(result.ok).toBe(false)
  })

  it('rejects locale as boolean', () => {
    const result = validatePatchBody({ locale: true })
    expect(result.ok).toBe(false)
  })

  it('rejects empty string locale', () => {
    const result = validatePatchBody({ locale: '' })
    expect(result.ok).toBe(false)
  })
})
