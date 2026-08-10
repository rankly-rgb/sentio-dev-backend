import { describe, it, expect } from 'vitest'
import { handleDetect } from '../functions/playbook-outcome-detector/index'

function mockQuery(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    update: () => builder,
    eq: () => builder,
    not: () => builder,
    gt: () => builder,
    in: () => builder,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject),
  }
  return builder
}

function buildMockSupabase(responses: Record<string, { data: unknown; error: unknown }>) {
  return {
    from: (table: string) => mockQuery(responses[table] ?? { data: null, error: null }),
  } as unknown as Parameters<typeof handleDetect>[0]
}

describe('playbook-outcome-detector — handleDetect', () => {
  it('T010: pending execution within the attribution window + invoice.paid → resolved', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString()
    const supabase = buildMockSupabase({
      accounts: { data: { id: 'acc-1' }, error: null },
      playbook_executions: { data: [{ id: 'ex-1' }], error: null },
    })

    const res = await handleDetect(supabase, 'org-1', 'cus_1')
    const json = await res.json() as { resolved_count: number }

    expect(res.status).toBe(200)
    expect(json.resolved_count).toBe(1)
    void future
  })

  it('T011: attribution window already expired → no automatic resolution', async () => {
    // The expiry filter (attribution_deadline_at > now) lives in the query
    // itself; simulate an expired window by returning no pending rows.
    const supabase = buildMockSupabase({
      accounts: { data: { id: 'acc-1' }, error: null },
      playbook_executions: { data: [], error: null },
    })

    const res = await handleDetect(supabase, 'org-1', 'cus_1')
    const json = await res.json() as { resolved_count: number }

    expect(json.resolved_count).toBe(0)
  })

  it('T012: several active pending executions for the same account → all marked resolved (FR-010)', async () => {
    const supabase = buildMockSupabase({
      accounts: { data: { id: 'acc-1' }, error: null },
      playbook_executions: { data: [{ id: 'ex-1' }, { id: 'ex-2' }, { id: 'ex-3' }], error: null },
    })

    const res = await handleDetect(supabase, 'org-1', 'cus_1')
    const json = await res.json() as { resolved_count: number }

    expect(json.resolved_count).toBe(3)
  })

  it('unknown stripe_customer_id for the organization → no-op, no error', async () => {
    const supabase = buildMockSupabase({
      accounts: { data: null, error: null },
    })

    const res = await handleDetect(supabase, 'org-1', 'cus_unknown')
    const json = await res.json() as { resolved_count: number; reason?: string }

    expect(res.status).toBe(200)
    expect(json.resolved_count).toBe(0)
    expect(json.reason).toBe('account_not_found')
  })
})
