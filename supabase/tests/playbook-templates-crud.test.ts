import { describe, it, expect } from 'vitest'
import { handleList, handleCreate, handleUpdate } from '../functions/playbook-templates-crud/index'

// ── Mock Supabase client with call recording ────────────────────
// Keyed by `${table}:${operation}` so select/insert/update on the
// same table can return distinct canned responses within one test.

interface Recorded { table: string; op: string; args: unknown[] }
interface Canned { data: unknown; error: unknown; count?: number }

function buildMockSupabase(responses: Record<string, Canned>, calls: Recorded[] = []) {
  return {
    from(table: string) {
      let currentOp = ''
      const record = (op: string, args: unknown[]) => calls.push({ table, op, args })
      const builder: Record<string, unknown> = {
        select: (...a: unknown[]) => { currentOp = currentOp || 'select'; record('select', a); return builder },
        insert: (...a: unknown[]) => { currentOp = 'insert'; record('insert', a); return builder },
        update: (...a: unknown[]) => { currentOp = 'update'; record('update', a); return builder },
        eq: (...a: unknown[]) => { record('eq', a); return builder },
        neq: (...a: unknown[]) => { record('neq', a); return builder },
        order: (...a: unknown[]) => { record('order', a); return builder },
        single: () => Promise.resolve(responses[`${table}:${currentOp}`] ?? { data: null, error: null }),
        maybeSingle: () => Promise.resolve(responses[`${table}:${currentOp}`] ?? { data: null, error: null }),
        then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
          Promise.resolve(responses[`${table}:${currentOp}`] ?? { data: null, error: null, count: 0 }).then(resolve, reject),
      }
      return builder
    },
  } as unknown as Parameters<typeof handleCreate>[0]
}

const TABLE = 'playbook_message_templates'

// ── T015: création ───────────────────────────────────────────

describe('POST /playbook-templates-crud — handleCreate', () => {
  it('creates a template with a valid category and non-empty body', async () => {
    const created = {
      id: 'tpl-1', organization_id: 'org-1', template_category: 'renewal',
      name: 'Renewal reminder', body: 'Hi {company}', is_active: true, is_default: false,
    }
    const supabase = buildMockSupabase({ [`${TABLE}:insert`]: { data: created, error: null } })

    const req = new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ template_category: 'renewal', name: 'Renewal reminder', body: 'Hi {company}' }),
    })
    const res = await handleCreate(supabase, req, 'org-1')

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual(created)
  })

  it('rejects an invalid template_category', async () => {
    const supabase = buildMockSupabase({})
    const req = new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ template_category: 'not_a_category', name: 'X', body: 'Y' }),
    })
    const res = await handleCreate(supabase, req, 'org-1')
    expect(res.status).toBe(400)
  })

  it('rejects an empty body', async () => {
    const supabase = buildMockSupabase({})
    const req = new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ template_category: 'renewal', name: 'X', body: '   ' }),
    })
    const res = await handleCreate(supabase, req, 'org-1')
    expect(res.status).toBe(400)
  })
})

// ── T016: modification + scoping organization_id ────────────

describe('PATCH /playbook-templates-crud — handleUpdate', () => {
  it('updates body, is_active and name', async () => {
    const current = {
      id: 'tpl-1', organization_id: 'org-1', template_category: 'renewal',
      name: 'Old name', body: 'Old body', is_active: true, is_default: false,
    }
    const updated = { ...current, name: 'New name', body: 'New body', is_active: false }
    const supabase = buildMockSupabase({
      [`${TABLE}:select`]: { data: current, error: null },
      [`${TABLE}:update`]: { data: updated, error: null },
    })

    const req = new Request('http://x', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'New name', body: 'New body', is_active: false }),
    })
    const res = await handleUpdate(supabase, 'tpl-1', req, 'org-1')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(updated)
  })

  it('a template belonging to another organization is never visible/modifiable → 404', async () => {
    // fetch-current scoped by organization_id: mismatched org → no row found
    const supabase = buildMockSupabase({
      [`${TABLE}:select`]: { data: null, error: null },
    })

    const req = new Request('http://x', { method: 'PATCH', body: JSON.stringify({ name: 'Hijack' }) })
    const res = await handleUpdate(supabase, 'tpl-other-org', req, 'org-1')

    expect(res.status).toBe(404)
  })
})

// ── T017: un seul is_default=true par (organization_id, template_category) ──

describe('is_default uniqueness enforcement (application-level, before DB constraint)', () => {
  it('handleCreate clears other defaults for the category before inserting a new default', async () => {
    const calls: Recorded[] = []
    const created = {
      id: 'tpl-2', organization_id: 'org-1', template_category: 'renewal',
      name: 'New default', body: 'Hi', is_active: true, is_default: true,
    }
    const supabase = buildMockSupabase({ [`${TABLE}:insert`]: { data: created, error: null } }, calls)

    const req = new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ template_category: 'renewal', name: 'New default', body: 'Hi', is_default: true }),
    })
    const res = await handleCreate(supabase, req, 'org-1')

    expect(res.status).toBe(201)
    const clearDefaultsCall = calls.find((c) => c.op === 'update' && (c.args[0] as Record<string, unknown>)?.is_default === false)
    expect(clearDefaultsCall).toBeDefined()
  })

  it('handleUpdate clears other defaults for the category before setting a new default, excluding itself', async () => {
    const calls: Recorded[] = []
    const current = {
      id: 'tpl-1', organization_id: 'org-1', template_category: 'renewal',
      name: 'X', body: 'Y', is_active: true, is_default: false,
    }
    const updated = { ...current, is_default: true }
    const supabase = buildMockSupabase({
      [`${TABLE}:select`]: { data: current, error: null },
      [`${TABLE}:update`]: { data: updated, error: null },
    }, calls)

    const req = new Request('http://x', { method: 'PATCH', body: JSON.stringify({ is_default: true }) })
    const res = await handleUpdate(supabase, 'tpl-1', req, 'org-1')

    expect(res.status).toBe(200)
    const clearDefaultsCall = calls.find((c) => c.op === 'update' && (c.args[0] as Record<string, unknown>)?.is_default === false)
    expect(clearDefaultsCall).toBeDefined()
    const excludeSelf = calls.some((c) => c.op === 'neq' && c.args[1] === 'tpl-1')
    expect(excludeSelf).toBe(true)
  })
})

// ── T018: liste filtrable par template_category ──────────────

describe('GET /playbook-templates-crud — handleList', () => {
  it('filters by template_category when provided', async () => {
    const calls: Recorded[] = []
    const rows = [{ id: 'tpl-1', template_category: 'renewal', name: 'X', body: 'Y', is_active: true, is_default: false }]
    const supabase = buildMockSupabase({ [`${TABLE}:select`]: { data: rows, error: null, count: 1 } }, calls)

    const url = new URL('http://x/playbook-templates-crud?template_category=renewal')
    const res = await handleList(supabase, url, 'org-1')
    const json = await res.json() as { data: unknown[]; total: number }

    expect(res.status).toBe(200)
    expect(json.data).toEqual(rows)
    expect(json.total).toBe(1)
    const categoryFilter = calls.some((c) => c.op === 'eq' && c.args[0] === 'template_category' && c.args[1] === 'renewal')
    expect(categoryFilter).toBe(true)
  })

  it('lists without a category filter', async () => {
    const rows = [
      { id: 'tpl-1', template_category: 'renewal', name: 'X', body: 'Y', is_active: true, is_default: false },
      { id: 'tpl-2', template_category: 'expansion', name: 'Z', body: 'W', is_active: true, is_default: false },
    ]
    const supabase = buildMockSupabase({ [`${TABLE}:select`]: { data: rows, error: null, count: 2 } })

    const url = new URL('http://x/playbook-templates-crud')
    const res = await handleList(supabase, url, 'org-1')
    const json = await res.json() as { data: unknown[]; total: number }

    expect(json.total).toBe(2)
  })
})
