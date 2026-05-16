import { describe, it, expect } from 'vitest'

// ── Miroir de localizePlaybook (playbook-crud/index.ts) ────────
//
// Chaîne de fallback :
//   FR : title_fr → title_en → title
//   EN : title_en → title_fr → title
// Idem pour description.
// Retourne toujours display_name et display_description non-null.

function nonEmpty(v: string | null | undefined): string | null {
  return v && v.trim().length > 0 ? v : null
}

function localizePlaybook(
  playbook: Record<string, unknown>,
  lang: 'fr' | 'en',
): Record<string, unknown> {
  const titleFr  = nonEmpty(playbook.title_fr as string | null)
  const titleEn  = nonEmpty(playbook.title_en as string | null)
  const titleLeg = (playbook.title as string) ?? ''

  const descFr  = nonEmpty(playbook.description_fr as string | null)
  const descEn  = nonEmpty(playbook.description_en as string | null)
  const descLeg = (playbook.description as string | null) ?? ''

  const displayName = lang === 'en'
    ? (titleEn ?? titleFr ?? titleLeg)
    : (titleFr ?? titleEn ?? titleLeg)

  const displayDescription = lang === 'en'
    ? (descEn ?? descFr ?? descLeg)
    : (descFr ?? descEn ?? descLeg)

  return { ...playbook, display_name: displayName, display_description: displayDescription }
}

// ── Fixtures ──────────────────────────────────────────────────

function makePlaybook(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'pb-001',
    organization_id: 'org-001',
    title: 'Playbook Prévention Churn',
    description: 'Détection et traitement des comptes en danger critique.',
    title_fr: 'Playbook Prévention Churn',
    title_en: null,
    description_fr: 'Détection et traitement des comptes en danger critique.',
    description_en: null,
    status: 'draft',
    ...overrides,
  }
}

// ── display_name — langue FR ────────────────────────────────────

describe('localizePlaybook — display_name FR', () => {
  it('retourne title_fr si disponible', () => {
    const pb = makePlaybook({ title_fr: 'Prévention Churn FR' })
    expect(localizePlaybook(pb, 'fr').display_name).toBe('Prévention Churn FR')
  })

  it('fallback sur title_en si title_fr est null', () => {
    const pb = makePlaybook({ title_fr: null, title_en: 'Churn Prevention EN' })
    expect(localizePlaybook(pb, 'fr').display_name).toBe('Churn Prevention EN')
  })

  it('fallback sur title legacy si title_fr et title_en sont null', () => {
    const pb = makePlaybook({ title_fr: null, title_en: null, title: 'Legacy Title' })
    expect(localizePlaybook(pb, 'fr').display_name).toBe('Legacy Title')
  })

  it('ignore title_fr vide (string vide traité comme null)', () => {
    const pb = makePlaybook({ title_fr: '', title_en: 'EN fallback' })
    expect(localizePlaybook(pb, 'fr').display_name).toBe('EN fallback')
  })
})

// ── display_name — langue EN ────────────────────────────────────

describe('localizePlaybook — display_name EN', () => {
  it('retourne title_en si disponible', () => {
    const pb = makePlaybook({ title_en: 'Churn Prevention EN' })
    expect(localizePlaybook(pb, 'en').display_name).toBe('Churn Prevention EN')
  })

  it('fallback sur title_fr si title_en est null', () => {
    const pb = makePlaybook({ title_fr: 'Prévention Churn FR', title_en: null })
    expect(localizePlaybook(pb, 'en').display_name).toBe('Prévention Churn FR')
  })

  it('fallback sur title legacy si title_en et title_fr sont null', () => {
    const pb = makePlaybook({ title_fr: null, title_en: null, title: 'Legacy Title' })
    expect(localizePlaybook(pb, 'en').display_name).toBe('Legacy Title')
  })

  it('ignore title_en vide (string vide traité comme null)', () => {
    const pb = makePlaybook({ title_en: '', title_fr: 'FR fallback' })
    expect(localizePlaybook(pb, 'en').display_name).toBe('FR fallback')
  })
})

// ── display_description — langue FR ────────────────────────────

describe('localizePlaybook — display_description FR', () => {
  it('retourne description_fr si disponible', () => {
    const pb = makePlaybook({ description_fr: 'Desc FR explicite' })
    expect(localizePlaybook(pb, 'fr').display_description).toBe('Desc FR explicite')
  })

  it('fallback sur description_en si description_fr est null', () => {
    const pb = makePlaybook({ description_fr: null, description_en: 'Desc EN' })
    expect(localizePlaybook(pb, 'fr').display_description).toBe('Desc EN')
  })

  it('fallback sur description legacy si les deux sont null', () => {
    const pb = makePlaybook({ description_fr: null, description_en: null, description: 'Legacy desc' })
    expect(localizePlaybook(pb, 'fr').display_description).toBe('Legacy desc')
  })
})

// ── display_description — langue EN ────────────────────────────

describe('localizePlaybook — display_description EN', () => {
  it('retourne description_en si disponible', () => {
    const pb = makePlaybook({ description_en: 'Desc EN' })
    expect(localizePlaybook(pb, 'en').display_description).toBe('Desc EN')
  })

  it('fallback sur description_fr si description_en est null', () => {
    const pb = makePlaybook({ description_fr: 'Desc FR', description_en: null })
    expect(localizePlaybook(pb, 'en').display_description).toBe('Desc FR')
  })

  it('fallback sur description legacy si les deux sont null', () => {
    const pb = makePlaybook({ description_fr: null, description_en: null, description: 'Legacy desc' })
    expect(localizePlaybook(pb, 'en').display_description).toBe('Legacy desc')
  })
})

// ── Champs bruts préservés ──────────────────────────────────────

describe('localizePlaybook — champs bruts préservés', () => {
  it('conserve tous les champs originaux', () => {
    const pb = makePlaybook({ title_en: 'EN', title_fr: 'FR', description_en: 'D-EN', description_fr: 'D-FR' })
    const result = localizePlaybook(pb, 'en')
    expect(result.title_fr).toBe('FR')
    expect(result.title_en).toBe('EN')
    expect(result.description_fr).toBe('D-FR')
    expect(result.description_en).toBe('D-EN')
    expect(result.id).toBe('pb-001')
    expect(result.status).toBe('draft')
  })

  it('display_name jamais null — fallback garanti', () => {
    const pb = makePlaybook({ title_fr: null, title_en: null, title: 'Fallback' })
    const result = localizePlaybook(pb, 'en')
    expect(result.display_name).not.toBeNull()
    expect(result.display_name).toBe('Fallback')
  })

  it('display_description jamais null — fallback garanti', () => {
    const pb = makePlaybook({ description_fr: null, description_en: null, description: 'Fallback desc' })
    const result = localizePlaybook(pb, 'fr')
    expect(result.display_description).not.toBeNull()
    expect(result.display_description).toBe('Fallback desc')
  })
})

// ── Liste de playbooks ──────────────────────────────────────────

describe('localizePlaybook — liste', () => {
  it('localise chaque élément en EN', () => {
    const playbooks = [
      makePlaybook({ id: 'pb-1', title_fr: 'PB A FR', title_en: 'PB A EN' }),
      makePlaybook({ id: 'pb-2', title_fr: 'PB B FR', title_en: null }),
    ]
    const results = playbooks.map((p) => localizePlaybook(p, 'en'))
    expect(results[0].display_name).toBe('PB A EN')
    expect(results[1].display_name).toBe('PB B FR')
  })

  it('localise chaque élément en FR', () => {
    const playbooks = [
      makePlaybook({ id: 'pb-1', title_fr: 'PB A FR', title_en: 'PB A EN' }),
      makePlaybook({ id: 'pb-2', title_fr: null, title_en: 'PB B EN' }),
    ]
    const results = playbooks.map((p) => localizePlaybook(p, 'fr'))
    expect(results[0].display_name).toBe('PB A FR')
    expect(results[1].display_name).toBe('PB B EN')
  })
})
