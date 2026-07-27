import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleSubscribe } from '../functions/sentio-billing-subscribe/index'

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
        upsert: (...a: unknown[]) => { currentOp = 'upsert'; record('upsert', a); return builder },
        update: (...a: unknown[]) => { currentOp = 'update'; record('update', a); return builder },
        eq: (...a: unknown[]) => { record('eq', a); return builder },
        gt: (...a: unknown[]) => { record('gt', a); return builder },
        maybeSingle: () => resolve(),
        single: () => resolve(),
        then: (res: (v: unknown) => void, rej: (e: unknown) => void) => resolve().then(res, rej),
      }
      return builder
    },
  } as unknown as Parameters<typeof handleSubscribe>[0]
}

// Grille confirmée 2026-07-27 (cf. pricing_tier_limits)
const growthLimits = { plan_tier: 'growth', max_active_accounts: 200, requires_appointment: false, alert_threshold_pct: 90 }
const freeLimits = { plan_tier: 'free', max_active_accounts: 30, requires_appointment: false, alert_threshold_pct: 90 }

let mockEnv: Record<string, string> = {}

beforeEach(() => {
  mockEnv = { STRIPE_BILLING_SECRET_KEY: 'sk_test_billing', STRIPE_BILLING_PRICE_ID_GROWTH: 'price_growth_test' }
  vi.stubGlobal('Deno', { env: { get: (key: string) => mockEnv[key] } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── T015 ──────────────────────────────────────────────────────

describe('POST /sentio-billing/subscribe — handleSubscribe', () => {
  it('T015: Free organization → Growth subscription → sentio_subscriptions created, status: active', async () => {
    const stripeFetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'cus_test' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sub_test', status: 'active', current_period_end: 1893456000 }), { status: 200 }))

    const supabase = buildMockSupabase({
      'accounts:select': { data: null, error: null, count: 5 },
      'pricing_tier_limits:select': { data: growthLimits, error: null },
      'sentio_subscriptions:select': { data: null, error: null }, // pas d'abonnement existant
      'sentio_subscriptions:upsert': { data: { id: 'sub-row-1', plan_tier: 'growth', status: 'active', current_period_end: '2030-01-01T00:00:00Z' }, error: null },
      'organizations:update': { data: null, error: null },
    })

    const res = await handleSubscribe(supabase, 'org-1', { target_plan_tier: 'growth' }, stripeFetcher)
    const json = await res.json() as { plan_tier: string; status: string }

    expect(res.status).toBe(200)
    expect(json.plan_tier).toBe('growth')
    expect(json.status).toBe('active')
    expect(stripeFetcher).toHaveBeenCalledTimes(2)
  })

  // ── T016 ────────────────────────────────────────────────────
  it('T016: attempting to subscribe/change to scale or enterprise → 403 (FR-012, no self-serve)', async () => {
    const supabase = buildMockSupabase({})
    const stripeFetcher = vi.fn()

    const resScale = await handleSubscribe(supabase, 'org-1', { target_plan_tier: 'scale' }, stripeFetcher)
    const resEnterprise = await handleSubscribe(supabase, 'org-1', { target_plan_tier: 'enterprise' }, stripeFetcher)

    expect(resScale.status).toBe(403)
    expect(resEnterprise.status).toBe(403)
    expect(stripeFetcher).not.toHaveBeenCalled()
  })

  // ── T017 ────────────────────────────────────────────────────
  it('T017: incoherent downgrade (active_accounts_count exceeds target tier limit) → 409', async () => {
    const supabase = buildMockSupabase({
      'accounts:select': { data: null, error: null, count: 35 }, // > free limit (30)
      'pricing_tier_limits:select': { data: freeLimits, error: null },
    })
    const stripeFetcher = vi.fn()

    const res = await handleSubscribe(supabase, 'org-1', { target_plan_tier: 'free' }, stripeFetcher)

    expect(res.status).toBe(409)
    expect(stripeFetcher).not.toHaveBeenCalled()
  })

  it('rejects an invalid target_plan_tier', async () => {
    const supabase = buildMockSupabase({})
    const res = await handleSubscribe(supabase, 'org-1', { target_plan_tier: 'not_a_tier' }, vi.fn())
    expect(res.status).toBe(400)
  })

  // ── T021 ────────────────────────────────────────────────────
  it('T021: absence of STRIPE_BILLING_SECRET_KEY → explicit error, no fallback', async () => {
    mockEnv = {} // ni STRIPE_BILLING_SECRET_KEY ni STRIPE_SECRET_KEY définis
    const supabase = buildMockSupabase({})
    const stripeFetcher = vi.fn()

    const res = await handleSubscribe(supabase, 'org-1', { target_plan_tier: 'growth' }, stripeFetcher)

    expect(res.status).toBe(500)
    expect(stripeFetcher).not.toHaveBeenCalled()
  })

  it('T021 (variant): absence of STRIPE_BILLING_PRICE_ID_GROWTH → explicit error, no fallback', async () => {
    mockEnv = { STRIPE_BILLING_SECRET_KEY: 'sk_test_billing' } // pas de price id
    const supabase = buildMockSupabase({
      'accounts:select': { data: null, error: null, count: 5 },
      'pricing_tier_limits:select': { data: growthLimits, error: null },
      'sentio_subscriptions:select': { data: null, error: null },
    })
    const stripeFetcher = vi.fn()

    const res = await handleSubscribe(supabase, 'org-1', { target_plan_tier: 'growth' }, stripeFetcher)

    expect(res.status).toBe(500)
    expect(stripeFetcher).not.toHaveBeenCalled()
  })
})
