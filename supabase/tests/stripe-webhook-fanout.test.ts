import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ── Fan-out multi-org (2026-08-20, mission clé Stripe partagée) ──
//
// stripe-webhook/index.ts n'exporte aucun handler testable directement
// (jsr: imports non résolvables par Vitest) — même contrainte que
// stripe-webhook.test.ts. Ce fichier ajoute :
//   1. Une copie miroir de resolveOrganizationIds, testée directement
//      (fonction quasi pure — un client Supabase stubbé suffit).
//   2. Des tests de non-régression par inspection du source pour les
//      invariants structurels que le fan-out doit préserver (boucle
//      per-org, idempotence scopée par organization_id, jamais de retour
//      anticipé dans le catch par-org — un retour y romprait l'isolation
//      entre orgs, exactement le bug que ce chantier corrige).

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(__dirname, '../functions/stripe-webhook/index.ts'), 'utf-8')

// ── Mirror de resolveOrganizationIds ──
interface StubEvent {
  account?: string
  data: { object: { customer?: string } }
}

function stubSupabase(config: {
  orgByAccountId?: Record<string, string>
  orgIdsByCustomer?: Record<string, string[]>
  fallbackActiveOrgId?: string | null
}) {
  return {
    from(table: string) {
      if (table === 'organizations') {
        const builder = {
          select: () => builder,
          eq: (col: string, val: string) => {
            if (col === 'stripe_account_id') {
              const id = config.orgByAccountId?.[val]
              return {
                ...builder,
                maybeSingle: () => Promise.resolve({ data: id ? { id } : null, error: null }),
              }
            }
            return builder
          },
          order: () => builder,
          limit: () => builder,
          maybeSingle: () => Promise.resolve({
            data: config.fallbackActiveOrgId ? { id: config.fallbackActiveOrgId } : null,
            error: null,
          }),
        }
        return builder
      }
      if (table === 'accounts') {
        const builder = {
          select: () => builder,
          eq: (col: string, val: string) => {
            if (col === 'stripe_customer_id') {
              const ids = config.orgIdsByCustomer?.[val] ?? []
              return Promise.resolve({ data: ids.map((id) => ({ organization_id: id })), error: null })
            }
            return builder
          },
        }
        return builder
      }
      throw new Error(`unexpected table: ${table}`)
    },
    // deno-lint-ignore no-explicit-any
  } as any
}

async function resolveOrganizationIds(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  event: StubEvent,
): Promise<string[]> {
  const stripeAccountId = event.account
  if (stripeAccountId) {
    const { data } = await supabase
      .from('organizations')
      .select('id')
      .eq('stripe_account_id', stripeAccountId)
      .maybeSingle()
    const orgId = data?.id ?? null
    return orgId ? [orgId] : []
  }

  const obj = event.data.object
  if (obj.customer) {
    const { data } = await supabase
      .from('accounts')
      .select('organization_id')
      .eq('stripe_customer_id', obj.customer)
    const ids = Array.from(new Set(
      (data ?? [])
        .map((row: { organization_id: string | null }) => row.organization_id)
        .filter((id: string | null): id is string => Boolean(id)),
    )) as string[]
    if (ids.length > 0) return ids
  }

  const { data } = await supabase
    .from('organizations')
    .select('id')
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return data?.id ? [data.id] : []
}

describe('resolveOrganizationIds (mirror)', () => {
  it('returns a single org when event.account matches (Stripe Connect path)', async () => {
    const supabase = stubSupabase({ orgByAccountId: { acct_123: 'org-a' } })
    expect(await resolveOrganizationIds(supabase, {
      account: 'acct_123',
      data: { object: {} },
    })).toEqual(['org-a'])
  })

  it('returns empty when event.account is set but matches no org', async () => {
    const supabase = stubSupabase({})
    expect(await resolveOrganizationIds(supabase, {
      account: 'acct_unknown',
      data: { object: {} },
    })).toEqual([])
  })

  it('returns a single org when exactly one org has synced this customer', async () => {
    const supabase = stubSupabase({ orgIdsByCustomer: { cus_1: ['org-a'] } })
    expect(await resolveOrganizationIds(supabase, {
      data: { object: { customer: 'cus_1' } },
    })).toEqual(['org-a'])
  })

  it('FAN-OUT: returns every org when the same customer was synced into multiple orgs (shared key)', async () => {
    const supabase = stubSupabase({ orgIdsByCustomer: { cus_shared: ['org-a', 'org-b'] } })
    expect(await resolveOrganizationIds(supabase, {
      data: { object: { customer: 'cus_shared' } },
    })).toEqual(['org-a', 'org-b'])
  })

  it('dedupes if the same org id appears twice for the same customer', async () => {
    const supabase = stubSupabase({ orgIdsByCustomer: { cus_dup: ['org-a', 'org-a'] } })
    expect(await resolveOrganizationIds(supabase, {
      data: { object: { customer: 'cus_dup' } },
    })).toEqual(['org-a'])
  })

  it('falls back to the oldest active org when the customer matches no account', async () => {
    const supabase = stubSupabase({ orgIdsByCustomer: {}, fallbackActiveOrgId: 'org-fallback' })
    expect(await resolveOrganizationIds(supabase, {
      data: { object: { customer: 'cus_unknown' } },
    })).toEqual(['org-fallback'])
  })

  it('falls back to the oldest active org when the event carries no customer at all', async () => {
    const supabase = stubSupabase({ fallbackActiveOrgId: 'org-fallback' })
    expect(await resolveOrganizationIds(supabase, { data: { object: {} } })).toEqual(['org-fallback'])
  })

  it('returns empty when nothing resolves anywhere, including the ultimate fallback', async () => {
    const supabase = stubSupabase({ fallbackActiveOrgId: null })
    expect(await resolveOrganizationIds(supabase, { data: { object: {} } })).toEqual([])
  })
})

describe('stripe-webhook fan-out — structural invariants (source inspection)', () => {
  it('resolveOrganizationIds is defined and used to drive the per-org loop', () => {
    expect(source).toContain('async function resolveOrganizationIds(')
    expect(source).toContain('const organizationIds = await resolveOrganizationIds(supabase, event)')
    expect(source).toContain('for (const organizationId of organizationIds)')
  })

  it('the idempotency check is scoped by organization_id — required for fan-out correctness', () => {
    const marker = "eq('webhook_event_id', event.id)"
    const idx = source.indexOf(marker)
    expect(idx).toBeGreaterThan(-1)
    const nextLines = source.slice(idx, idx + 200)
    expect(nextLines).toContain("eq('organization_id', organizationId)")
    expect(nextLines).toContain("eq('sync_status', 'completed')")
  })

  it('a per-org failure never returns early from inside the loop — it must fall through to the next org', () => {
    // Isole le corps de la boucle for(...) { ... } (accolade correspondante
    // trouvée par comptage, la boucle contient elle-même des switch/try
    // imbriqués donc un simple indexOf du prochain '}' ne suffit pas).
    const loopStart = source.indexOf('for (const organizationId of organizationIds) {')
    expect(loopStart).toBeGreaterThan(-1)
    let depth = 0
    let i = loopStart + 'for (const organizationId of organizationIds) {'.length - 1
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++
      if (source[i] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    const loopBody = source.slice(loopStart, i + 1)

    // Le catch par-org doit exister et ne JAMAIS contenir `return` — un
    // retour anticipé y romprait le fan-out (les orgs restantes ne
    // seraient jamais traitées).
    const catchIdx = loopBody.indexOf('} catch (err) {')
    expect(catchIdx).toBeGreaterThan(-1)
    const catchBody = loopBody.slice(catchIdx)
    expect(catchBody).not.toMatch(/\breturn\b/)
    expect(catchBody).toContain('logger?.fail(msg)')
    expect(catchBody).toContain('writeToDLQ(')
    expect(catchBody).toContain('alertSlack(')
  })

  it('the response after the loop aggregates all matched orgs', () => {
    const returnIdx = source.indexOf('organizations_processed: organizationIds.length')
    expect(returnIdx).toBeGreaterThan(-1)
  })

  it('a shared-customer fan-out (>1 org) is traced non-blockingly, distinct from a prod anomaly', () => {
    expect(source).toContain("event: 'webhook_fan_out'")
    expect(source).toContain('test_mode_only: true')
  })
})
