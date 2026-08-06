import { describe, it, expect } from 'vitest'
import { handleGetOne } from '../functions/accounts-api/index'

// ── Mock Supabase query builder ─────────────────────────────────
// Every chain method returns itself; the object is thenable so it can be
// awaited directly (matches queries like `.select(...).eq(...).limit(200)`
// with no terminal call) or resolved via `.maybeSingle()`. This exercises
// the REAL handleGetOne() — not a mirrored copy — against canned per-table
// responses, per the request: "appelle directement le handler".
function mockQuery(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    neq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject),
  }
  return builder
}

function buildMockSupabase(responses: Record<string, { data: unknown; error: unknown }>) {
  return {
    from: (table: string) => mockQuery(responses[table] ?? { data: null, error: null }),
  } as unknown as Parameters<typeof handleGetOne>[0]
}

// ── Fixtures ──────────────────────────────────────────────────

const baseAccountFields = {
  id: 'acc-fixture-001',
  organization_id: 'org-fixture-001',
  stripe_customer_id: 'cus_fixtureABC',
  hubspot_company_id: null,
  display_name: 'Acme Corp',
  plan_tier: 'growth',
  billing_interval: 'annual',
  mrr_cents: 149900,
  mrr_status: 'ok' as const,
  is_delinquent: false,
  arr_cents: 1798800,
  seat_count: 12,
  seat_limit: 20,
  contract_start_date: '2025-01-15',
  contract_end_date: '2027-01-15',
  scores_calculated_at: '2026-07-26T03:00:00Z',
  created_at: '2025-01-10T00:00:00Z',
  updated_at: '2026-07-26T03:00:00Z',
  churn_risk_score: 15,
  churn_risk_band: 'low' as const,
  risk_signals_triggered: [],
  risk_signals_evaluated: 6,
  expansion_score: 60,
  expansion_score_status: 'available' as const,
  expansion_unavailable_reason: null,
  // Frozen v2 dimensions — still in the row, just not read as "live" anymore
  product_usage_score: 72.5,
  financial_score: 88,
  engagement_score: 65,
  contract_score: 90,
}

const completeAccount = {
  ...baseAccountFields,
  health_score: 82.4,
  health_score_status: 'complete',
  health_score_max_points: 100,
  health_score_band: 'healthy',
  trend_30d: 'up',
  payment_health_score: 91,
  revenue_dynamics_score: 78,
  contract_renewal_score: 78,
  score_breakdown: {
    payment_health: { score: 91, status: 'available', weight: 35, signals: [] },
    revenue_dynamics: { score: 78, status: 'available', weight: 35, signals: [] },
    contract_renewal: { score: 78, status: 'available', weight: 30, signals: [] },
  },
}

const partialAccount = {
  ...baseAccountFields,
  id: 'acc-fixture-002',
  display_name: 'Beta Industries',
  health_score: 42.32,
  health_score_status: 'partial',
  health_score_max_points: 65,
  health_score_band: 'watch',
  trend_30d: 'down',
  payment_health_score: null,
  revenue_dynamics_score: 71.2,
  contract_renewal_score: 58.0,
  score_breakdown: {
    payment_health: { score: null, status: 'unavailable', weight: 35, signals: [] },
    revenue_dynamics: { score: 71.2, status: 'available', weight: 35, signals: [] },
    contract_renewal: { score: 58.0, status: 'available', weight: 30, signals: [] },
  },
}

const insufficientAccount = {
  ...baseAccountFields,
  id: 'acc-fixture-003',
  display_name: null,
  contract_start_date: '2026-07-01',
  contract_end_date: null,
  billing_interval: 'monthly',
  seat_count: null,
  seat_limit: null,
  health_score: null,
  health_score_status: 'insufficient',
  health_score_max_points: 30,
  health_score_band: null,
  trend_30d: 'flat',
  payment_health_score: null,
  revenue_dynamics_score: null,
  contract_renewal_score: 45,
  score_breakdown: {
    payment_health: { score: null, status: 'unavailable', weight: 35, signals: [] },
    revenue_dynamics: { score: null, status: 'unavailable', weight: 35, signals: [] },
    contract_renewal: { score: 45, status: 'available', weight: 30, signals: [] },
  },
  churn_risk_score: 0,
  churn_risk_band: 'low' as const,
  risk_signals_evaluated: 1,
  // seat_count/seat_limit are null on this fixture — expansion must reflect
  // that (S6: never a silent value when seat data is unconfigured). The
  // baseAccountFields expansion_score=60/'available' was copy-pasted
  // unchanged into this fixture in the previous version, which was wrong:
  // handleGetOne doesn't recompute expansion from seat_count/seat_limit
  // (that's calcExpansionScoreV2's job in calculate-scores, already covered
  // by scoring-v3.test.ts) — it only passes through whatever calculate-scores
  // last wrote. A real row with null seat data would never have
  // expansion_score_status='available', so the fixture must not either.
  expansion_score: null,
  expansion_score_status: 'unavailable' as const,
  expansion_unavailable_reason: 'seat_data_not_configured',
  // Frozen v2 values also varied here (not identical across fixtures) so a
  // reader can't mistake "same placeholder on all 3" for a sign that these
  // are being recomputed live — they're static per-account DB values, just
  // deliberately different ones per fixture.
  product_usage_score: 12.0,
  engagement_score: 30,
}

// risk_score must match the account's own churn_risk_score: calculate-scores
// writes both segment_memberships.risk_score and accounts.churn_risk_score
// from the same `scores` object in the same cron cycle (see
// calculate-scores/index.ts:496 vs :778), so in real data they agree except
// for legitimate temporal staleness between two runs — never a fixed
// constant regardless of which account it's attached to.
const segmentsFixture = (segmentType: string, riskScore: number) => ({
  data: [
    { status: 'active', added_at: '2026-07-01T00:00:00Z', risk_score: riskScore, account_segments: { segment_type: segmentType, priority: 'low' } },
  ],
  error: null,
})

async function runHandleGetOne(account: Record<string, unknown>, segmentType: string) {
  const supabase = buildMockSupabase({
    accounts: { data: account, error: null },
    invoices: { data: [], error: null },
    hubspot_companies: { data: null, error: null },
    ai_insights: { data: [], error: null },
    segment_memberships: segmentsFixture(segmentType, account.churn_risk_score as number),
    profiles_: { data: { last_seen_at: '2026-07-25T00:00:00Z' }, error: null },
  })
  const response = await handleGetOne(supabase, account.id as string, account.organization_id as string, 'user-fixture-001')
  return response.json()
}

// ── Tests ─────────────────────────────────────────────────────
// Regression guard on the GET ?id= payload shape across the 3
// health_score_status cases — not just presence of fields, but the exact
// contract behavior: null propagation (S1), narrative text, primary_segment
// sourced from segment_memberships without recomputation.

describe('accounts-api handleGetOne — payload shape by health_score_status', () => {
  it('complete: all 3 dimensions available, band=healthy, no frozen-as-live leakage', async () => {
    const json = await runHandleGetOne(completeAccount, 'champions')
    console.log('=== FIXTURE: health_score_status=complete ===\n' + JSON.stringify(json, null, 2))

    expect(json.data.scores.health.status).toBe('complete')
    expect(json.data.scores.health.value).toBe(82.4)
    expect(json.data.scores.health.band).toBe('healthy')
    expect(json.data.scores.health.trend_30d).toBe('up')
    expect(json.data.scores.payment_health.value).toBe(91)
    expect(json.data.scores.churn_risk.band).toBe('low')
    expect(json.data.scores.expansion.status).toBe('available')
    expect(json.data.mrr_status).toBe('ok')
    expect(json.data.is_delinquent).toBe(false)
    expect(json.data.primary_segment).toBe('champions')
    expect(json.data.score_breakdown.payment_health.status).toBe('available')
    expect(json.data.segments[0].risk_score).toBe(json.data.scores.churn_risk.value)
  })

  it('partial: payment_health unavailable (null), health still computable on reduced max_points', async () => {
    const json = await runHandleGetOne(partialAccount, 'a_risque_leger')
    console.log('=== FIXTURE: health_score_status=partial ===\n' + JSON.stringify(json, null, 2))

    expect(json.data.scores.health.status).toBe('partial')
    expect(json.data.scores.health.value).toBe(42.32)
    expect(json.data.scores.health.max_points).toBe(65)
    expect(json.data.scores.health.band).toBe('watch')
    expect(json.data.scores.payment_health.value).toBeNull()
    expect(json.data.score_breakdown.payment_health.status).toBe('unavailable')
    expect(json.data.score_breakdown.payment_health.score).toBeNull()
    expect(json.data.primary_segment).toBe('a_risque_leger')
    expect(json.data.segments[0].risk_score).toBe(json.data.scores.churn_risk.value)
  })

  it('insufficient: health_score null, band null, never a fabricated 0/50 default', async () => {
    const json = await runHandleGetOne(insufficientAccount, 'donnees_insuffisantes')
    console.log('=== FIXTURE: health_score_status=insufficient ===\n' + JSON.stringify(json, null, 2))

    expect(json.data.scores.health.value).toBeNull()
    expect(json.data.scores.health.status).toBe('insufficient')
    expect(json.data.scores.health.band).toBeNull()
    expect(json.data.scores.health.trend_30d).toBe('flat')
    expect(json.data.scores.payment_health.value).toBeNull()
    expect(json.data.scores.revenue_dynamics.value).toBeNull()
    expect(json.data.primary_segment).toBe('donnees_insuffisantes')
    // health.value must be null, never 0 or 50 (S1)
    expect(json.data.scores.health.value).not.toBe(0)
    expect(json.data.scores.health.value).not.toBe(50)
    // S6: seat_count/seat_limit are null on this fixture — expansion must be
    // explicitly unavailable, never a silent leftover value (regression
    // guard for the fixture bug caught in review: expansion was previously
    // hardcoded 'available' on this account despite null seat data).
    expect(json.data.seat_count).toBeNull()
    expect(json.data.seat_limit).toBeNull()
    expect(json.data.scores.expansion.status).toBe('unavailable')
    expect(json.data.scores.expansion.value).toBeNull()
    expect(json.data.scores.expansion.unavailable_reason).toBe('seat_data_not_configured')
    // segments[].risk_score must match scores.churn_risk.value (both written
    // from the same `scores` object in the same cron cycle in production).
    expect(json.data.segments[0].risk_score).toBe(json.data.scores.churn_risk.value)
  })

  it('never returns en_expansion or nouveaux as primary_segment', async () => {
    const withNouveaux = await runHandleGetOne(completeAccount, 'nouveaux')
    // segments array only contains 'nouveaux' (non-exclusive lifecycle segment,
    // no health segment membership yet) — primary_segment must be null, not 'nouveaux'
    expect(withNouveaux.data.primary_segment).toBeNull()
  })

  it('mrr_status=unavailable passes through unchanged (frontend renders "Not billable" instead of $0, Phase 5.5)', async () => {
    const unavailableAccount = { ...completeAccount, mrr_status: 'unavailable' as const, mrr_cents: 0 }
    const json = await runHandleGetOne(unavailableAccount, 'champions')
    expect(json.data.mrr_status).toBe('unavailable')
  })

  it('is_delinquent=true passes through unchanged (audit délinquence 2026-08-06, feeds the frontend Past Due badge)', async () => {
    const delinquentAccount = { ...completeAccount, is_delinquent: true }
    const json = await runHandleGetOne(delinquentAccount, 'impayes')
    expect(json.data.is_delinquent).toBe(true)
  })
})
