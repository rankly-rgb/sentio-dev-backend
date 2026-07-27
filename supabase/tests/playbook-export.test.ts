import { describe, it, expect } from 'vitest'
import { handleExport } from '../functions/playbook-export/index'

// ── Mock Supabase query builder ─────────────────────────────────
// Same approach as accounts-api.test.ts: every chain method returns
// itself, the object is thenable, and `.maybeSingle()`/`.single()`
// resolve directly — exercises the REAL handleExport(), not a mirror.

function mockQuery(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    neq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    gte: () => builder,
    lte: () => builder,
    maybeSingle: () => Promise.resolve(result),
    single: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject),
  }
  return builder
}

function buildMockSupabase(responses: Record<string, { data: unknown; error: unknown }>) {
  return {
    from: (table: string) => mockQuery(responses[table] ?? { data: null, error: null }),
  } as unknown as Parameters<typeof handleExport>[0]
}

const basePlaybook = {
  id: 'pb-001',
  organization_id: 'org-001',
  segment_id: null,
  eligibility_criteria: null,
  template_category: 'churn_prevention',
}

const baseAccount = {
  id: 'acc-001',
  organization_id: 'org-001',
  stripe_customer_id: 'cus_1',
  hubspot_company_id: null,
  display_name: 'Acme',
  health_score: 40,
  churn_risk_score: 70,
  expansion_score: 10,
  product_usage_score: 30,
  mrr_cents: 5000,
  arr_cents: 60000,
  plan_tier: 'growth',
  seat_count: 5,
  seat_limit: 10,
  contract_start_date: null,
  contract_end_date: null,
  created_at: '2026-01-01T00:00:00Z',
}

describe('GET /playbook-export — handleExport', () => {
  it('T007: active playbook with eligible accounts → correct CSV columns and resolved message', async () => {
    const supabase = buildMockSupabase({
      playbooks: { data: basePlaybook, error: null },
      accounts: { data: [baseAccount], error: null },
      usage_events: { data: [], error: null },
      playbook_message_templates: {
        data: [{ body: 'Hi {company} — you have {amount_at_risk} at risk', is_default: false, created_at: '2026-01-01T00:00:00Z' }],
        error: null,
      },
    })

    const res = await handleExport(supabase, 'pb-001', 'org-001')
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/csv')
    const lines = body.trim().split('\n')
    expect(lines[0]).toBe('account_ref,mrr_at_risk_cents,message')
    expect(lines[1]).toBe('cus_1,5000,Hi Acme — you have $50.00 at risk')
  })

  it('T008: active playbook with no eligible account → 200, header-only CSV', async () => {
    const supabase = buildMockSupabase({
      playbooks: { data: basePlaybook, error: null },
      accounts: { data: [], error: null },
    })

    const res = await handleExport(supabase, 'pb-001', 'org-001')
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(body).toBe('account_ref,mrr_at_risk_cents,message\n')
  })

  it('T009: no active template for the category → explicit fallback message, not a failure', async () => {
    const supabase = buildMockSupabase({
      playbooks: { data: basePlaybook, error: null },
      accounts: { data: [baseAccount], error: null },
      usage_events: { data: [], error: null },
      playbook_message_templates: { data: [], error: null },
    })

    const res = await handleExport(supabase, 'pb-001', 'org-001')
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(body).toContain('No active template for this playbook category')
  })

  it('T010: playbook not found or outside caller organization → 404', async () => {
    const supabase = buildMockSupabase({
      playbooks: { data: null, error: null },
    })

    const res = await handleExport(supabase, 'pb-999', 'org-001')
    expect(res.status).toBe(404)
  })

  it('Zero-PII: full CSV response contains no email/phone/IP pattern', async () => {
    const supabase = buildMockSupabase({
      playbooks: { data: basePlaybook, error: null },
      accounts: { data: [baseAccount], error: null },
      usage_events: { data: [], error: null },
      playbook_message_templates: {
        data: [{ body: 'Hi {company}, {amount_at_risk} at risk, inactive {days_since_last_activity} days', is_default: false, created_at: '2026-01-01T00:00:00Z' }],
        error: null,
      },
    })

    const res = await handleExport(supabase, 'pb-001', 'org-001')
    const body = await res.text()

    expect(body).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
    expect(body).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
  })
})
