import { describe, it, expect } from 'vitest'
import { handleLinkVisit } from '../functions/playbook-link/index'

interface Recorded { table: string; op: string; args: unknown[] }

function buildMockSupabase(
  responses: Record<string, { data: unknown; error: unknown }>,
  calls: Recorded[] = [],
) {
  return {
    from(table: string) {
      const record = (op: string, args: unknown[]) => calls.push({ table, op, args })
      const builder: Record<string, unknown> = {
        select: (...a: unknown[]) => { record('select', a); return builder },
        insert: (...a: unknown[]) => {
          record('insert', a)
          return Promise.resolve(responses[`${table}:insert`] ?? { data: null, error: null })
        },
        eq: (...a: unknown[]) => { record('eq', a); return builder },
        maybeSingle: () => Promise.resolve(responses[`${table}:select`] ?? { data: null, error: null }),
      }
      return builder
    },
  } as unknown as Parameters<typeof handleLinkVisit>[0]
}

const baseExecution = {
  id: 'ex-1',
  organization_id: 'org-1',
  playbook_id: 'pb-1',
  stripe_customer_id: 'cus_1',
}

describe('GET /playbook-link/{execution_id} — handleLinkVisit', () => {
  it('T017: visiting the link → 302 to the configured destination + a click row is created', async () => {
    const calls: Recorded[] = []
    const supabase = buildMockSupabase({
      'playbook_executions:select': { data: baseExecution, error: null },
      'playbooks:select': { data: { link_redirect_url: 'https://example.com/thanks' }, error: null },
      'playbook_execution_clicks:insert': { data: null, error: null },
    }, calls)

    const res = await handleLinkVisit(supabase, 'ex-1')

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('https://example.com/thanks')
    expect(calls.some((c) => c.table === 'playbook_execution_clicks' && c.op === 'insert')).toBe(true)
  })

  it('falls back to NEXT_PUBLIC_APP_URL when the playbook has no link_redirect_url configured', async () => {
    const supabase = buildMockSupabase({
      'playbook_executions:select': { data: baseExecution, error: null },
      'playbooks:select': { data: { link_redirect_url: null }, error: null },
      'playbook_execution_clicks:insert': { data: null, error: null },
    })

    const res = await handleLinkVisit(supabase, 'ex-1')

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBeTruthy()
    expect(res.headers.get('Location')).not.toBe('')
  })

  it('T018: the click row contains ONLY organization_id, playbook_execution_id, stripe_customer_id — no PII', async () => {
    const calls: Recorded[] = []
    const supabase = buildMockSupabase({
      'playbook_executions:select': { data: baseExecution, error: null },
      'playbooks:select': { data: { link_redirect_url: 'https://example.com' }, error: null },
      'playbook_execution_clicks:insert': { data: null, error: null },
    }, calls)

    await handleLinkVisit(supabase, 'ex-1')

    const insertCall = calls.find((c) => c.table === 'playbook_execution_clicks' && c.op === 'insert')
    const payload = insertCall?.args[0] as Record<string, unknown>

    expect(Object.keys(payload).sort()).toEqual(['organization_id', 'playbook_execution_id', 'stripe_customer_id'].sort())
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
    expect(serialized).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
    expect(payload).not.toHaveProperty('email')
    expect(payload).not.toHaveProperty('name')
    expect(payload).not.toHaveProperty('phone')
    expect(payload).not.toHaveProperty('ip')
  })

  it('T019: the destination is resolved only from the execution/playbook in DB — the function accepts no destination input at all', async () => {
    // handleLinkVisit's signature is (supabase, executionId) — there is
    // structurally no channel for a client-supplied destination. Same
    // executionId, only the DB-configured link_redirect_url differs.
    const supabaseA = buildMockSupabase({
      'playbook_executions:select': { data: baseExecution, error: null },
      'playbooks:select': { data: { link_redirect_url: 'https://a.example.com' }, error: null },
      'playbook_execution_clicks:insert': { data: null, error: null },
    })
    const supabaseB = buildMockSupabase({
      'playbook_executions:select': { data: baseExecution, error: null },
      'playbooks:select': { data: { link_redirect_url: 'https://b.example.com' }, error: null },
      'playbook_execution_clicks:insert': { data: null, error: null },
    })

    const resA = await handleLinkVisit(supabaseA, 'ex-1')
    const resB = await handleLinkVisit(supabaseB, 'ex-1')

    expect(resA.headers.get('Location')).toBe('https://a.example.com')
    expect(resB.headers.get('Location')).toBe('https://b.example.com')
  })

  it('T020: no deduplication — two visits of the same link produce two distinct click log entries', async () => {
    const calls: Recorded[] = []
    const supabase = buildMockSupabase({
      'playbook_executions:select': { data: baseExecution, error: null },
      'playbooks:select': { data: { link_redirect_url: 'https://example.com' }, error: null },
      'playbook_execution_clicks:insert': { data: null, error: null },
    }, calls)

    await handleLinkVisit(supabase, 'ex-1')
    await handleLinkVisit(supabase, 'ex-1')

    const insertCalls = calls.filter((c) => c.table === 'playbook_execution_clicks' && c.op === 'insert')
    expect(insertCalls.length).toBe(2)
  })

  it('T021: unknown execution_id → 404, no information about the organization leaked', async () => {
    const supabase = buildMockSupabase({
      'playbook_executions:select': { data: null, error: null },
    })

    const res = await handleLinkVisit(supabase, 'ex-unknown')
    const body = await res.text()

    expect(res.status).toBe(404)
    expect(body).not.toContain('org-1')
    expect(body).not.toContain('organization')
  })
})
