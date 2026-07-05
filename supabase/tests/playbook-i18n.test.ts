import { describe, it, expect } from 'vitest'

// ── Mirror of localizePlaybook (playbook-crud/index.ts) ────────
//
// Fallback chain: title_en → title; description_en → description.
// Always returns non-null display_name / display_description.

function nonEmpty(v: string | null | undefined): string | null {
  return v && v.trim().length > 0 ? v : null
}

function localizePlaybook(
  playbook: Record<string, unknown>,
): Record<string, unknown> {
  const titleEn  = nonEmpty(playbook.title_en as string | null)
  const titleLeg = (playbook.title as string) ?? ''

  const descEn  = nonEmpty(playbook.description_en as string | null)
  const descLeg = (playbook.description as string | null) ?? ''

  return {
    ...playbook,
    display_name: titleEn ?? titleLeg,
    display_description: descEn ?? descLeg,
  }
}

// ── Fixtures ──────────────────────────────────────────────────

function makePlaybook(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'pb-001',
    organization_id: 'org-001',
    title: 'Churn Prevention Playbook',
    description: 'Detects and handles accounts in critical danger.',
    title_en: null,
    description_en: null,
    status: 'draft',
    ...overrides,
  }
}

// ── display_name ─────────────────────────────────────────────

describe('localizePlaybook — display_name', () => {
  it('returns title_en when available', () => {
    const pb = makePlaybook({ title_en: 'Churn Prevention EN' })
    expect(localizePlaybook(pb).display_name).toBe('Churn Prevention EN')
  })

  it('falls back to legacy title when title_en is null', () => {
    const pb = makePlaybook({ title_en: null, title: 'Legacy Title' })
    expect(localizePlaybook(pb).display_name).toBe('Legacy Title')
  })

  it('ignores an empty title_en (treated as null)', () => {
    const pb = makePlaybook({ title_en: '', title: 'Legacy fallback' })
    expect(localizePlaybook(pb).display_name).toBe('Legacy fallback')
  })
})

// ── display_description ───────────────────────────────────────

describe('localizePlaybook — display_description', () => {
  it('returns description_en when available', () => {
    const pb = makePlaybook({ description_en: 'Desc EN' })
    expect(localizePlaybook(pb).display_description).toBe('Desc EN')
  })

  it('falls back to legacy description when description_en is null', () => {
    const pb = makePlaybook({ description_en: null, description: 'Legacy desc' })
    expect(localizePlaybook(pb).display_description).toBe('Legacy desc')
  })
})

// ── Raw fields preserved ────────────────────────────────────────

describe('localizePlaybook — raw fields preserved', () => {
  it('keeps all original fields', () => {
    const pb = makePlaybook({ title_en: 'EN', description_en: 'D-EN' })
    const result = localizePlaybook(pb)
    expect(result.title_en).toBe('EN')
    expect(result.description_en).toBe('D-EN')
    expect(result.id).toBe('pb-001')
    expect(result.status).toBe('draft')
  })

  it('display_name is never null — fallback guaranteed', () => {
    const pb = makePlaybook({ title_en: null, title: 'Fallback' })
    const result = localizePlaybook(pb)
    expect(result.display_name).not.toBeNull()
    expect(result.display_name).toBe('Fallback')
  })

  it('display_description is never null — fallback guaranteed', () => {
    const pb = makePlaybook({ description_en: null, description: 'Fallback desc' })
    const result = localizePlaybook(pb)
    expect(result.display_description).not.toBeNull()
    expect(result.display_description).toBe('Fallback desc')
  })
})

// ── List of playbooks ────────────────────────────────────────────

describe('localizePlaybook — list', () => {
  it('localizes each element', () => {
    const playbooks = [
      makePlaybook({ id: 'pb-1', title: 'PB A legacy', title_en: 'PB A EN' }),
      makePlaybook({ id: 'pb-2', title: 'PB B legacy', title_en: null }),
    ]
    const results = playbooks.map((p) => localizePlaybook(p))
    expect(results[0].display_name).toBe('PB A EN')
    expect(results[1].display_name).toBe('PB B legacy')
  })
})
