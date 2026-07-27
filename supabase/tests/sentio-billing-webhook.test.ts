import { describe, it, expect } from 'vitest'
import { handleSentioBillingEvent } from '../functions/sentio-billing-webhook/index'

interface Recorded { table: string; op: string; args: unknown[] }

function buildMockSupabase(
  responses: Record<string, { data: unknown; error: unknown }>,
  calls: Recorded[] = [],
) {
  return {
    from(table: string) {
      let currentOp = ''
      const record = (op: string, args: unknown[]) => calls.push({ table, op, args })
      const resolve = () => Promise.resolve(responses[`${table}:${currentOp}`] ?? { data: null, error: null })
      const builder: Record<string, unknown> = {
        select: (...a: unknown[]) => { currentOp = currentOp || 'select'; record('select', a); return builder },
        update: (...a: unknown[]) => { currentOp = 'update'; record('update', a); return builder },
        eq: (...a: unknown[]) => { record('eq', a); return builder },
        maybeSingle: () => resolve(),
        then: (res: (v: unknown) => void, rej: (e: unknown) => void) => resolve().then(res, rej),
      }
      return builder
    },
  } as unknown as Parameters<typeof handleSentioBillingEvent>[0]
}

// ── T018 ────────────────────────────────────────────────────

describe('sentio-billing-webhook — customer.subscription.deleted (T018)', () => {
  it('marks the subscription canceled and reverts the organization to Free', async () => {
    const calls: Recorded[] = []
    const supabase = buildMockSupabase({
      'sentio_subscriptions:select': { data: { organization_id: 'org-1' }, error: null },
      'sentio_subscriptions:update': { data: null, error: null },
      'organizations:update': { data: null, error: null },
    }, calls)

    const event = { id: 'evt_1', type: 'customer.subscription.deleted', data: { object: { id: 'sub_test' } } }
    const res = await handleSentioBillingEvent(supabase, event)

    expect(res.status).toBe(200)
    const subUpdate = calls.find((c) => c.table === 'sentio_subscriptions' && c.op === 'update')
    const payload = subUpdate?.args[0] as Record<string, unknown>
    expect(payload.status).toBe('canceled')
    expect(payload.plan_tier).toBe('free')

    const orgUpdate = calls.find((c) => c.table === 'organizations' && c.op === 'update')
    expect((orgUpdate?.args[0] as Record<string, unknown>).plan_type).toBe('free')
  })
})

// ── T019 ────────────────────────────────────────────────────

describe('sentio-billing-webhook — invoice.payment_failed (T019)', () => {
  it('applies a grace state (status: past_due) — no immediate punitive gating', async () => {
    const calls: Recorded[] = []
    const supabase = buildMockSupabase({
      'sentio_subscriptions:update': { data: null, error: null },
    }, calls)

    const event = { id: 'evt_2', type: 'invoice.payment_failed', data: { object: { customer: 'cus_test', subscription: 'sub_test' } } }
    const res = await handleSentioBillingEvent(supabase, event)

    expect(res.status).toBe(200)
    const update = calls.find((c) => c.table === 'sentio_subscriptions' && c.op === 'update')
    expect((update?.args[0] as Record<string, unknown>).status).toBe('past_due')
    // Pas de gating punitif : ni plan_tier ni sentio_stripe_subscription_id ne sont touchés ici.
    expect(update?.args[0]).not.toHaveProperty('plan_tier')
  })
})

describe('sentio-billing-webhook — customer.subscription.updated', () => {
  it('syncs status and current_period_end from the Stripe object', async () => {
    const calls: Recorded[] = []
    const supabase = buildMockSupabase({ 'sentio_subscriptions:update': { data: null, error: null } }, calls)

    const event = {
      id: 'evt_3',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_test', status: 'active', current_period_end: 1893456000, cancel_at_period_end: false } },
    }
    const res = await handleSentioBillingEvent(supabase, event)

    expect(res.status).toBe(200)
    const update = calls.find((c) => c.table === 'sentio_subscriptions' && c.op === 'update')
    expect((update?.args[0] as Record<string, unknown>).status).toBe('active')
  })
})
