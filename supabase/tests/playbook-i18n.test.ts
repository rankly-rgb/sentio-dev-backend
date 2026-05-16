import { describe, it, expect } from 'vitest'

// ── Miroir de localizePlaybook (playbook-crud/index.ts) ────────

function localizePlaybook(
  playbook: Record<string, unknown>,
  lang: 'fr' | 'en',
): Record<string, unknown> {
  if (lang !== 'en') return playbook
  return {
    ...playbook,
    title: (playbook.title_en as string | null) ?? playbook.title,
    description: (playbook.description_en as string | null) ?? playbook.description,
  }
}

// ── Fixtures ──────────────────────────────────────────────────

function makePlaybook(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'pb-001',
    organization_id: 'org-001',
    title: 'Playbook Prévention Churn',
    description: 'Détection et traitement des comptes en danger critique.',
    title_en: null,
    description_en: null,
    status: 'draft',
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────

describe('localizePlaybook — langue FR', () => {
  it('retourne le playbook inchangé en FR', () => {
    const pb = makePlaybook({ title_en: 'Churn Prevention Playbook' })
    const result = localizePlaybook(pb, 'fr')
    expect(result.title).toBe('Playbook Prévention Churn')
  })

  it('ne modifie pas description en FR même si description_en existe', () => {
    const pb = makePlaybook({ description_en: 'Detect and handle critical danger accounts.' })
    const result = localizePlaybook(pb, 'fr')
    expect(result.description).toBe('Détection et traitement des comptes en danger critique.')
  })

  it('retourne la même référence objet en FR (pas de copie inutile)', () => {
    const pb = makePlaybook()
    expect(localizePlaybook(pb, 'fr')).toBe(pb)
  })
})

describe('localizePlaybook — langue EN avec title_en défini', () => {
  it('remplace title par title_en si title_en est non-null', () => {
    const pb = makePlaybook({ title_en: 'Churn Prevention Playbook' })
    const result = localizePlaybook(pb, 'en')
    expect(result.title).toBe('Churn Prevention Playbook')
  })

  it('remplace description par description_en si non-null', () => {
    const pb = makePlaybook({
      title_en: 'Churn Prevention Playbook',
      description_en: 'Detect and handle critical danger accounts.',
    })
    const result = localizePlaybook(pb, 'en')
    expect(result.description).toBe('Detect and handle critical danger accounts.')
  })

  it('conserve tous les autres champs inchangés', () => {
    const pb = makePlaybook({ title_en: 'Churn Prevention Playbook' })
    const result = localizePlaybook(pb, 'en')
    expect(result.id).toBe('pb-001')
    expect(result.status).toBe('draft')
    expect(result.title_en).toBe('Churn Prevention Playbook')
  })
})

describe('localizePlaybook — langue EN sans title_en (fallback)', () => {
  it('utilise title FR si title_en est null', () => {
    const pb = makePlaybook({ title_en: null })
    const result = localizePlaybook(pb, 'en')
    expect(result.title).toBe('Playbook Prévention Churn')
  })

  it('utilise description FR si description_en est null', () => {
    const pb = makePlaybook({ title_en: 'Churn Prevention Playbook', description_en: null })
    const result = localizePlaybook(pb, 'en')
    expect(result.description).toBe('Détection et traitement des comptes en danger critique.')
  })

  it('fallback fonctionne si title_en est absent de l\'objet', () => {
    const { title_en: _unused, ...pbWithoutEn } = makePlaybook()
    const result = localizePlaybook(pbWithoutEn, 'en')
    expect(result.title).toBe('Playbook Prévention Churn')
  })
})

describe('localizePlaybook — liste de playbooks', () => {
  it('localise chaque élément d\'une liste en EN', () => {
    const playbooks = [
      makePlaybook({ id: 'pb-1', title: 'Playbook A', title_en: 'Playbook A EN' }),
      makePlaybook({ id: 'pb-2', title: 'Playbook B', title_en: null }),
    ]
    const results = playbooks.map((p) => localizePlaybook(p, 'en'))
    expect(results[0].title).toBe('Playbook A EN')
    expect(results[1].title).toBe('Playbook B')
  })

  it('laisse la liste inchangée en FR', () => {
    const playbooks = [
      makePlaybook({ id: 'pb-1', title: 'Playbook A', title_en: 'Playbook A EN' }),
    ]
    const results = playbooks.map((p) => localizePlaybook(p, 'fr'))
    expect(results[0].title).toBe('Playbook A')
  })
})
