import { describe, it, expect } from 'vitest'
import {
  handleMarkExecuted,
  handleUnmarkExecuted,
  handleAttributionStatus,
  handleNudgeResponse,
} from '../functions/playbook-execute/index'

// ── Mock Supabase client with per-table/op call recording ────────
// Same op-aware approach as playbook-templates-crud.test.ts. A canned
// response may be a value or a function of the last `.update()`/
// `.insert()` payload, so tests can assert on values the handler
// actually computed (e.g. attribution_deadline_at) instead of
// hardcoding them.

interface Recorded { table: string; op: string; args: unknown[] }
type Canned =
  | { data: unknown; error: unknown }
  | ((lastArgs: unknown[]) => { data: unknown; error: unknown })

const MS_PER_DAY = 86400000

function buildMockSupabase(responses: Record<string, Canned>, calls: Recorded[] = []) {
  return {
    from(table: string) {
      let currentOp = ''
      let lastArgs: unknown[] = []
      const record = (op: string, args: unknown[]) => calls.push({ table, op, args })
      const resolve = () => {
        const canned = responses[`${table}:${currentOp}`] ?? { data: null, error: null }
        return Promise.resolve(typeof canned === 'function' ? canned(lastArgs) : canned)
      }
      const builder: Record<string, unknown> = {
        select: (...a: unknown[]) => { currentOp = currentOp || 'select'; record('select', a); return builder },
        update: (...a: unknown[]) => { currentOp = 'update'; lastArgs = a; record('update', a); return builder },
        insert: (...a: unknown[]) => { currentOp = 'insert'; lastArgs = a; record('insert', a); return builder },
        eq: (...a: unknown[]) => { record('eq', a); return builder },
        neq: (...a: unknown[]) => { record('neq', a); return builder },
        in: (...a: unknown[]) => { record('in', a); return builder },
        not: (...a: unknown[]) => { record('not', a); return builder },
        gt: (...a: unknown[]) => { record('gt', a); return builder },
        gte: (...a: unknown[]) => { record('gte', a); return builder },
        order: (...a: unknown[]) => { record('order', a); return builder },
        limit: (...a: unknown[]) => { record('limit', a); return builder },
        maybeSingle: () => resolve(),
        single: () => resolve(),
        then: (res: (v: unknown) => void, rej: (e: unknown) => void) => resolve().then(res, rej),
      }
      return builder
    },
  } as unknown as Parameters<typeof handleMarkExecuted>[0]
}

// ── T005/T006/T007/T008: mark-executed ──────────────────────

describe('POST .../mark-executed — handleMarkExecuted', () => {
  it('T005: unmarked execution → executed_at set, attribution_deadline_at = executed_at + attribution_window_days', async () => {
    const supabase = buildMockSupabase({
      'playbook_executions:select': { data: { id: 'ex1', playbook_id: 'pb1', manual_executed_at: null, attribution_deadline_at: null }, error: null },
      'playbooks:select': { data: { attribution_window_days: 7 }, error: null },
      'playbook_executions:update': (args) => {
        const payload = args[0] as { manual_executed_at: string; attribution_deadline_at: string }
        return { data: { id: 'ex1', manual_executed_at: payload.manual_executed_at, attribution_deadline_at: payload.attribution_deadline_at }, error: null }
      },
    })

    const res = await handleMarkExecuted(supabase, 'ex1', 'org-1')
    const json = await res.json() as { execution_id: string; executed_at: string; attribution_deadline_at: string }

    expect(res.status).toBe(200)
    const days = (new Date(json.attribution_deadline_at).getTime() - new Date(json.executed_at).getTime()) / MS_PER_DAY
    expect(Math.round(days)).toBe(7)
  })

  it('T006: no attribution_window_days configured → default 14 days applied', async () => {
    const supabase = buildMockSupabase({
      'playbook_executions:select': { data: { id: 'ex1', playbook_id: 'pb1', manual_executed_at: null, attribution_deadline_at: null }, error: null },
      'playbooks:select': { data: { attribution_window_days: null }, error: null },
      'playbook_executions:update': (args) => {
        const payload = args[0] as { manual_executed_at: string; attribution_deadline_at: string }
        return { data: { id: 'ex1', manual_executed_at: payload.manual_executed_at, attribution_deadline_at: payload.attribution_deadline_at }, error: null }
      },
    })

    const res = await handleMarkExecuted(supabase, 'ex1', 'org-1')
    const json = await res.json() as { executed_at: string; attribution_deadline_at: string }

    const days = (new Date(json.attribution_deadline_at).getTime() - new Date(json.executed_at).getTime()) / MS_PER_DAY
    expect(Math.round(days)).toBe(14)
  })

  it('T007: idempotent — second call on an already-marked execution → 200, no new timestamp', async () => {
    const calls: Recorded[] = []
    const supabase = buildMockSupabase({
      'playbook_executions:select': {
        data: { id: 'ex1', playbook_id: 'pb1', manual_executed_at: '2026-07-01T00:00:00Z', attribution_deadline_at: '2026-07-15T00:00:00Z' },
        error: null,
      },
    }, calls)

    const res = await handleMarkExecuted(supabase, 'ex1', 'org-1')
    const json = await res.json() as { executed_at: string; attribution_deadline_at: string }

    expect(res.status).toBe(200)
    expect(json.executed_at).toBe('2026-07-01T00:00:00Z')
    expect(json.attribution_deadline_at).toBe('2026-07-15T00:00:00Z')
    expect(calls.some((c) => c.op === 'update')).toBe(false)
  })

  it('T008: nonexistent execution or outside caller organization → 404', async () => {
    const supabase = buildMockSupabase({
      'playbook_executions:select': { data: null, error: null },
    })

    const res = await handleMarkExecuted(supabase, 'ex-missing', 'org-1')
    expect(res.status).toBe(404)
  })
})

// ── T008A: unmark-executed ───────────────────────────────────

describe('POST .../unmark-executed — handleUnmarkExecuted', () => {
  it('within the 5-minute window → executed_at/attribution_deadline_at reset to null', async () => {
    const recentIso = new Date(Date.now() - 60_000).toISOString()
    const supabase = buildMockSupabase({
      'playbook_executions:select': {
        data: { id: 'ex1', manual_executed_at: recentIso, account_converted: false, resolved_via: null, nudge_response: null },
        error: null,
      },
      'playbook_executions:update': { data: { id: 'ex1' }, error: null },
    })

    const res = await handleUnmarkExecuted(supabase, 'ex1', 'org-1')
    const json = await res.json() as { executed_at: string | null; attribution_deadline_at: string | null }

    expect(res.status).toBe(200)
    expect(json.executed_at).toBeNull()
    expect(json.attribution_deadline_at).toBeNull()
  })

  it('after the 5-minute window has expired → 409', async () => {
    const oldIso = new Date(Date.now() - 10 * 60_000).toISOString()
    const supabase = buildMockSupabase({
      'playbook_executions:select': {
        data: { id: 'ex1', manual_executed_at: oldIso, account_converted: false, resolved_via: null, nudge_response: null },
        error: null,
      },
    })

    const res = await handleUnmarkExecuted(supabase, 'ex1', 'org-1')
    expect(res.status).toBe(409)
  })

  it('on an execution that is not marked executed → 200 idempotent, no-op', async () => {
    const calls: Recorded[] = []
    const supabase = buildMockSupabase({
      'playbook_executions:select': {
        data: { id: 'ex1', manual_executed_at: null, account_converted: false, resolved_via: null, nudge_response: null },
        error: null,
      },
    }, calls)

    const res = await handleUnmarkExecuted(supabase, 'ex1', 'org-1')
    const json = await res.json() as { executed_at: string | null }

    expect(res.status).toBe(200)
    expect(json.executed_at).toBeNull()
    expect(calls.some((c) => c.op === 'update')).toBe(false)
  })

  it('if account_converted = true (automatic resolution already detected) → 409, even within the window', async () => {
    const recentIso = new Date(Date.now() - 60_000).toISOString()
    const supabase = buildMockSupabase({
      'playbook_executions:select': {
        data: { id: 'ex1', manual_executed_at: recentIso, account_converted: true, resolved_via: 'invoice_paid_auto', nudge_response: null },
        error: null,
      },
    })

    const res = await handleUnmarkExecuted(supabase, 'ex1', 'org-1')
    expect(res.status).toBe(409)
  })

  it('if a nudge_response is already recorded → 409, even within the window', async () => {
    const recentIso = new Date(Date.now() - 60_000).toISOString()
    const supabase = buildMockSupabase({
      'playbook_executions:select': {
        data: { id: 'ex1', manual_executed_at: recentIso, account_converted: false, resolved_via: null, nudge_response: 'not_resolved' },
        error: null,
      },
    })

    const res = await handleUnmarkExecuted(supabase, 'ex1', 'org-1')
    expect(res.status).toBe(409)
  })
})

// ── T024: attribution-status (4 states) ──────────────────────

describe('GET .../attribution-status — handleAttributionStatus', () => {
  it('not_executed: manual_executed_at is null → time_remaining_seconds null', async () => {
    const supabase = buildMockSupabase({
      'playbook_executions:select': { data: { id: 'ex1', manual_executed_at: null, attribution_deadline_at: null, account_converted: false }, error: null },
    })
    const res = await handleAttributionStatus(supabase, 'ex1', 'org-1')
    const json = await res.json() as { attribution_status: string; time_remaining_seconds: number | null }
    expect(json.attribution_status).toBe('not_executed')
    expect(json.time_remaining_seconds).toBeNull()
  })

  it('active: deadline in the future, not yet converted → time_remaining_seconds > 0', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString()
    const supabase = buildMockSupabase({
      'playbook_executions:select': { data: { id: 'ex1', manual_executed_at: '2026-07-01T00:00:00Z', attribution_deadline_at: future, account_converted: false }, error: null },
    })
    const res = await handleAttributionStatus(supabase, 'ex1', 'org-1')
    const json = await res.json() as { attribution_status: string; time_remaining_seconds: number | null }
    expect(json.attribution_status).toBe('active')
    expect(json.time_remaining_seconds).toBeGreaterThan(0)
  })

  it('expired: deadline in the past, not converted → time_remaining_seconds 0', async () => {
    const past = new Date(Date.now() - 3600_000).toISOString()
    const supabase = buildMockSupabase({
      'playbook_executions:select': { data: { id: 'ex1', manual_executed_at: '2026-07-01T00:00:00Z', attribution_deadline_at: past, account_converted: false }, error: null },
    })
    const res = await handleAttributionStatus(supabase, 'ex1', 'org-1')
    const json = await res.json() as { attribution_status: string; time_remaining_seconds: number | null }
    expect(json.attribution_status).toBe('expired')
    expect(json.time_remaining_seconds).toBe(0)
  })

  it('resolved: account_converted = true → time_remaining_seconds 0, regardless of deadline', async () => {
    const past = new Date(Date.now() - 3600_000).toISOString()
    const supabase = buildMockSupabase({
      'playbook_executions:select': { data: { id: 'ex1', manual_executed_at: '2026-07-01T00:00:00Z', attribution_deadline_at: past, account_converted: true }, error: null },
    })
    const res = await handleAttributionStatus(supabase, 'ex1', 'org-1')
    const json = await res.json() as { attribution_status: string; time_remaining_seconds: number | null }
    expect(json.attribution_status).toBe('resolved')
    expect(json.time_remaining_seconds).toBe(0)
  })

  it('404 on unknown/other-organization execution', async () => {
    const supabase = buildMockSupabase({ 'playbook_executions:select': { data: null, error: null } })
    const res = await handleAttributionStatus(supabase, 'ex-missing', 'org-1')
    expect(res.status).toBe(404)
  })
})

// ── T026/T027: nudge-response ─────────────────────────────────

describe('POST .../nudge-response — handleNudgeResponse', () => {
  it('T026: records nudge_response/nudge_responded_at, never touches account_converted/resolved_via', async () => {
    const calls: Recorded[] = []
    const supabase = buildMockSupabase({
      'playbook_executions:select': { data: { id: 'ex1', manual_executed_at: '2026-07-01T00:00:00Z' }, error: null },
      'playbook_executions:update': (args) => {
        const payload = args[0] as { nudge_response: string; nudge_responded_at: string }
        return { data: { id: 'ex1', nudge_response: payload.nudge_response, nudge_responded_at: payload.nudge_responded_at }, error: null }
      },
    }, calls)

    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ response: 'resolved' }) })
    const res = await handleNudgeResponse(supabase, 'ex1', req, 'org-1')
    const json = await res.json() as { nudge_response: string; nudge_responded_at: string }

    expect(res.status).toBe(200)
    expect(json.nudge_response).toBe('resolved')
    expect(json.nudge_responded_at).toBeTruthy()

    const updateCall = calls.find((c) => c.op === 'update' && c.table === 'playbook_executions')
    const payload = updateCall?.args[0] as Record<string, unknown>
    expect(payload).not.toHaveProperty('account_converted')
    expect(payload).not.toHaveProperty('resolved_via')
  })

  it('T027: execution not yet marked executed (executed_at IS NULL) → 409', async () => {
    const supabase = buildMockSupabase({
      'playbook_executions:select': { data: { id: 'ex1', manual_executed_at: null }, error: null },
    })

    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ response: 'resolved' }) })
    const res = await handleNudgeResponse(supabase, 'ex1', req, 'org-1')
    expect(res.status).toBe(409)
  })

  it('rejects an invalid response value', async () => {
    const supabase = buildMockSupabase({})
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ response: 'maybe' }) })
    const res = await handleNudgeResponse(supabase, 'ex1', req, 'org-1')
    expect(res.status).toBe(400)
  })
})
