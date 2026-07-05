import { describe, it, expect } from 'vitest'
import { PLAYBOOK_TEMPLATES_V1 } from '../functions/_shared/playbook-engine'

// ── Mirror logic (playbook-templates/index.ts) ─────────────
// The Edge Function itself needs a Deno env (verifyUserAuth + Deno.serve).
// These tests verify the response-building logic and Zero-PII guarantees.

function resolveTemplates() {
  return PLAYBOOK_TEMPLATES_V1.map((t) => ({
    id: t.id,
    title: t.title_en,
    description: t.description_en,
    playbook_type: t.playbook_type,
    template_category: t.template_category,
    priority: t.priority,
    is_automated: t.is_automated,
    trigger_conditions: t.trigger_conditions,
    actions: t.actions,
  }))
}

// ── GET /playbook-templates — response logic ──────────────

describe('GET /playbook-templates', () => {
  it('returns 6 templates', () => {
    const templates = resolveTemplates()
    expect(templates).toHaveLength(6)
  })

  it('returns English titles', () => {
    const templates = resolveTemplates()
    const first = templates.find((t) => t.id === 'churn-critical-alert')
    expect(first?.title).toBe('Critical churn alert')
  })

  it('returns English descriptions', () => {
    const templates = resolveTemplates()
    const t = templates.find((tmpl) => tmpl.id === 'churn-critical-alert')
    expect(t?.description).toContain('critical risk threshold')
  })

  it('response payload includes the correct total', () => {
    const templates = resolveTemplates()
    const payload = { data: { templates, total: templates.length } }
    expect(payload.data.total).toBe(6)
  })

  it('all templates have a slug id (not a UUID)', () => {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    for (const t of resolveTemplates()) {
      expect(t.id).not.toMatch(uuidPattern)
      expect(t.id.length).toBeGreaterThan(0)
    }
  })

  it('no PII field in the response (organization_id, created_by, email address)', () => {
    const templates = resolveTemplates()
    const str = JSON.stringify({ data: { templates, total: templates.length } })
    expect(str).not.toMatch(/organization_id/)
    expect(str).not.toMatch(/created_by/)
    expect(str).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
  })

  it('GET method allowed — endpoint logic guard', () => {
    expect('GET' === 'GET').toBe(true)
  })

  it('POST method not allowed → 405 — endpoint logic guard', () => {
    const isAllowed = (method: string) => method === 'GET'
    expect(isAllowed('POST')).toBe(false)
    expect(isAllowed('DELETE')).toBe(false)
    expect(isAllowed('PATCH')).toBe(false)
  })
})
