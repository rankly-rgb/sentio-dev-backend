import { describe, it, expect } from 'vitest'
import { handlePricingStatus, syncPlanLimitInsight } from '../functions/pricing-status/index'
import type { TierLimits } from '../functions/_shared/pricing'

interface Recorded { table: string; op: string; args: unknown[] }
type Canned = { data: unknown; error: unknown; count?: number }

function buildMockSupabase(responses: Record<string, Canned>, calls: Recorded[] = []) {
  return {
    from(table: string) {
      let currentOp = ''
      const record = (op: string, args: unknown[]) => calls.push({ table, op, args })
      const resolve = () => Promise.resolve(responses[`${table}:${currentOp}`] ?? { data: null, error: null })
      const builder: Record<string, unknown> = {
        select: (...a: unknown[]) => { currentOp = currentOp || 'select'; record('select', a); return builder },
        insert: (...a: unknown[]) => { currentOp = 'insert'; record('insert', a); return resolve() },
        update: (...a: unknown[]) => { currentOp = 'update'; record('update', a); return builder },
        eq: (...a: unknown[]) => { record('eq', a); return builder },
        gt: (...a: unknown[]) => { record('gt', a); return builder },
        is: (...a: unknown[]) => { record('is', a); return builder },
        maybeSingle: () => resolve(),
        then: (res: (v: unknown) => void, rej: (e: unknown) => void) => resolve().then(res, rej),
      }
      return builder
    },
  } as unknown as Parameters<typeof handlePricingStatus>[0]
}

const growthLimits: TierLimits = {
  plan_tier: 'growth',
  max_active_accounts: 200, // grille confirmée 2026-07-27 (cf. pricing_tier_limits)
  requires_appointment: false,
  alert_threshold_pct: 90,
}

describe('GET /pricing-status — handlePricingStatus', () => {
  it('returns plan_tier, usage_pct and alert_active for an org below the threshold', async () => {
    const supabase = buildMockSupabase({
      'organizations:select': { data: { plan_type: 'growth' }, error: null },
      'pricing_tier_limits:select': { data: growthLimits, error: null },
      'accounts:select': { data: null, error: null, count: 100 },
      'ai_insights:select': { data: null, error: null },
    })

    const res = await handlePricingStatus(supabase, 'org-1')
    const json = await res.json() as { plan_tier: string; usage_pct: number; alert_active: boolean }

    expect(res.status).toBe(200)
    expect(json.plan_tier).toBe('growth')
    expect(json.usage_pct).toBe(50)
    expect(json.alert_active).toBe(false)
  })

  // ── T009 ────────────────────────────────────────────────────
  it('T009: alert_active = true as soon as usage_pct >= alert_threshold_pct (default 90)', async () => {
    const supabase = buildMockSupabase({
      'organizations:select': { data: { plan_type: 'growth' }, error: null },
      'pricing_tier_limits:select': { data: growthLimits, error: null },
      'accounts:select': { data: null, error: null, count: 180 },
      'ai_insights:select': { data: null, error: null },
      'ai_insights:insert': { data: null, error: null },
    })

    const res = await handlePricingStatus(supabase, 'org-1')
    const json = await res.json() as { alert_active: boolean }
    expect(json.alert_active).toBe(true)
  })

  // ── T010 ────────────────────────────────────────────────────
  it('T010: alert_active goes back to false once active_accounts_count drops below the threshold', async () => {
    const calls: Recorded[] = []
    const supabase = buildMockSupabase({
      'organizations:select': { data: { plan_type: 'growth' }, error: null },
      'pricing_tier_limits:select': { data: growthLimits, error: null },
      'accounts:select': { data: null, error: null, count: 80 },
      'ai_insights:select': { data: { id: 'insight-1' }, error: null }, // alerte précédemment active
    }, calls)

    const res = await handlePricingStatus(supabase, 'org-1')
    const json = await res.json() as { alert_active: boolean }

    expect(json.alert_active).toBe(false)
    const resolveCall = calls.find((c) => c.table === 'ai_insights' && c.op === 'update')
    expect(resolveCall).toBeDefined()
    expect((resolveCall?.args[0] as Record<string, unknown>).status).toBe('resolved')
  })

  // ── T011 ────────────────────────────────────────────────────
  it('T011: creates a plan_limit_warning insight with account_id = null and coherent metadata.signals', async () => {
    const calls: Recorded[] = []
    const supabase = buildMockSupabase({
      'organizations:select': { data: { plan_type: 'growth' }, error: null },
      'pricing_tier_limits:select': { data: growthLimits, error: null },
      'accounts:select': { data: null, error: null, count: 190 },
      'ai_insights:select': { data: null, error: null },
      'ai_insights:insert': { data: null, error: null },
    }, calls)

    await handlePricingStatus(supabase, 'org-1')

    const insertCall = calls.find((c) => c.table === 'ai_insights' && c.op === 'insert')
    const payload = insertCall?.args[0] as Record<string, unknown>

    expect(payload.insight_type).toBe('plan_limit_warning')
    expect(payload.account_id).toBeNull()
    expect(payload.metadata).toMatchObject({
      signals: expect.arrayContaining([
        'active_accounts_count:190',
        'max_active_accounts:200',
        'usage_pct:95',
      ]),
    })
  })

  it('does not insert a duplicate insight when one is already active', async () => {
    const calls: Recorded[] = []
    const supabase = buildMockSupabase({
      'organizations:select': { data: { plan_type: 'growth' }, error: null },
      'pricing_tier_limits:select': { data: growthLimits, error: null },
      'accounts:select': { data: null, error: null, count: 190 },
      'ai_insights:select': { data: { id: 'insight-existing' }, error: null },
    }, calls)

    await handlePricingStatus(supabase, 'org-1')
    expect(calls.some((c) => c.table === 'ai_insights' && c.op === 'insert')).toBe(false)
  })

  it('404 when the organization does not exist', async () => {
    const supabase = buildMockSupabase({ 'organizations:select': { data: null, error: null } })
    const res = await handlePricingStatus(supabase, 'org-missing')
    expect(res.status).toBe(404)
  })
})

describe('syncPlanLimitInsight (unit)', () => {
  it('is a no-op when alert is inactive and no prior insight exists', async () => {
    const calls: Recorded[] = []
    const supabase = buildMockSupabase({ 'ai_insights:select': { data: null, error: null } }, calls)
    await syncPlanLimitInsight(supabase, 'org-1', false, 10, growthLimits)
    expect(calls.some((c) => c.op === 'insert' || c.op === 'update')).toBe(false)
  })
})
