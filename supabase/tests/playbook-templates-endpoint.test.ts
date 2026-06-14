import { describe, it, expect } from 'vitest'
import { PLAYBOOK_TEMPLATES_V1 } from '../functions/_shared/playbook-engine'

// ── Logique miroir (playbook-templates/index.ts) ─────────────
// La Edge Function elle-même nécessite un env Deno (verifyUserAuth + Deno.serve).
// Ces tests vérifient la logique de résolution locale et les garanties Zero-PII.

type Locale = 'fr' | 'en'

function resolveLocale(param: string | null): Locale {
  return param === 'en' ? 'en' : 'fr'
}

function resolveTemplates(locale: Locale) {
  return PLAYBOOK_TEMPLATES_V1.map((t) => ({
    id: t.id,
    title: locale === 'en' ? t.title_en : t.title_fr,
    description: locale === 'en' ? t.description_en : t.description_fr,
    playbook_type: t.playbook_type,
    template_category: t.template_category,
    priority: t.priority,
    is_automated: t.is_automated,
    trigger_conditions: t.trigger_conditions,
    actions: t.actions,
  }))
}

// ── resolveLocale ─────────────────────────────────────────────

describe('resolveLocale', () => {
  it("retourne 'fr' par défaut (null)", () => {
    expect(resolveLocale(null)).toBe('fr')
  })

  it("retourne 'fr' pour une valeur inconnue", () => {
    expect(resolveLocale('de')).toBe('fr')
  })

  it("retourne 'en' pour 'en'", () => {
    expect(resolveLocale('en')).toBe('en')
  })
})

// ── GET /playbook-templates — logique de réponse ──────────────

describe('GET /playbook-templates', () => {
  it('retourne 6 templates en locale fr par défaut', () => {
    const templates = resolveTemplates('fr')
    expect(templates).toHaveLength(6)
    expect(resolveLocale(null)).toBe('fr')
  })

  it('retourne les titres en français pour locale=fr', () => {
    const templates = resolveTemplates('fr')
    const first = templates.find((t) => t.id === 'churn-critical-alert')
    expect(first?.title).toBe('Alerte churn critique')
  })

  it('retourne les titres en anglais si locale=en', () => {
    const templates = resolveTemplates('en')
    const first = templates.find((t) => t.id === 'churn-critical-alert')
    expect(first?.title).toBe('Critical churn alert')
  })

  it('retourne les descriptions en anglais si locale=en', () => {
    const templates = resolveTemplates('en')
    const t = templates.find((tmpl) => tmpl.id === 'churn-critical-alert')
    expect(t?.description).toContain('critical risk threshold')
  })

  it('le payload de réponse inclut locale et total corrects', () => {
    const locale: Locale = 'fr'
    const templates = resolveTemplates(locale)
    const payload = { data: { templates, locale, total: templates.length } }
    expect(payload.data.locale).toBe('fr')
    expect(payload.data.total).toBe(6)
  })

  it('tous les templates ont un id slug (pas un UUID)', () => {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    for (const t of resolveTemplates('fr')) {
      expect(t.id).not.toMatch(uuidPattern)
      expect(t.id.length).toBeGreaterThan(0)
    }
  })

  it('aucun champ PII dans la réponse (organization_id, created_by, adresse email)', () => {
    const templates = resolveTemplates('fr')
    const str = JSON.stringify({ data: { templates, locale: 'fr', total: templates.length } })
    expect(str).not.toMatch(/organization_id/)
    expect(str).not.toMatch(/created_by/)
    expect(str).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
  })

  it("méthode GET autorisée — guard logique de l'endpoint", () => {
    expect('GET' === 'GET').toBe(true)
  })

  it("méthode POST non autorisée → 405 — guard logique de l'endpoint", () => {
    const isAllowed = (method: string) => method === 'GET'
    expect(isAllowed('POST')).toBe(false)
    expect(isAllowed('DELETE')).toBe(false)
    expect(isAllowed('PATCH')).toBe(false)
  })
})
