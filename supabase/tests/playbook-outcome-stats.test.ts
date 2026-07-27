import { describe, it, expect } from 'vitest'
import { handleStats, buildGroupStats } from '../functions/playbook-outcome-stats/index'

function mockQuery(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject),
  }
  return builder
}

function buildMockSupabase(responses: Record<string, { data: unknown; error: unknown }>) {
  return {
    from: (table: string) => mockQuery(responses[table] ?? { data: null, error: null }),
  } as unknown as Parameters<typeof handleStats>[0]
}

describe('buildGroupStats', () => {
  it('computes resolution_rate as resolved_count / sample_size', () => {
    const rows = [
      { account_converted: true }, { account_converted: true }, { account_converted: false },
    ]
    const stats = buildGroupStats(rows)
    expect(stats.sample_size).toBe(3)
    expect(stats.resolved_count).toBe(2)
    expect(stats.resolution_rate).toBeCloseTo(2 / 3)
  })

  it('sample_size_warning is true when sample_size < 20', () => {
    expect(buildGroupStats(Array(19).fill({ account_converted: false })).sample_size_warning).toBe(true)
    expect(buildGroupStats(Array(20).fill({ account_converted: false })).sample_size_warning).toBe(false)
  })

  it('resolution_rate is null (never 0) when sample_size = 0', () => {
    const stats = buildGroupStats([])
    expect(stats.sample_size).toBe(0)
    expect(stats.resolution_rate).toBeNull()
  })
})

describe('GET /playbook-outcome-stats — handleStats', () => {
  it('T025: aggregates executed vs not_executed correctly, with sample_size_warning and null-not-zero rate', async () => {
    const rows = [
      ...Array(25).fill({ manual_executed_at: '2026-07-01T00:00:00Z', account_converted: true }),
      ...Array(10).fill({ manual_executed_at: '2026-07-01T00:00:00Z', account_converted: false }),
      // not_executed group: empty (sample_size 0)
    ]
    const supabase = buildMockSupabase({
      playbooks: { data: { id: 'pb-1' }, error: null },
      playbook_executions: { data: rows, error: null },
    })

    const res = await handleStats(supabase, 'pb-1', 'org-1')
    const json = await res.json() as {
      executed: { sample_size: number; resolved_count: number; resolution_rate: number | null; sample_size_warning: boolean }
      not_executed: { sample_size: number; resolved_count: number; resolution_rate: number | null; sample_size_warning: boolean }
    }

    expect(res.status).toBe(200)
    expect(json.executed.sample_size).toBe(35)
    expect(json.executed.resolved_count).toBe(25)
    expect(json.executed.sample_size_warning).toBe(false)
    expect(json.not_executed.sample_size).toBe(0)
    expect(json.not_executed.resolution_rate).toBeNull()
    expect(json.not_executed.sample_size_warning).toBe(true)
  })

  it('404 when the playbook does not exist or belongs to another organization', async () => {
    const supabase = buildMockSupabase({ playbooks: { data: null, error: null } })
    const res = await handleStats(supabase, 'pb-missing', 'org-1')
    expect(res.status).toBe(404)
  })
})
