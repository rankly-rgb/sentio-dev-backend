import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Preuve comportementale réelle de l'isolation per-org (2026-08-20 suite)
//
// Le test précédent (stripe-webhook-fanout.test.ts) prouvait l'isolation
// par inspection du source ("le catch par-org ne contient jamais `return`")
// — insuffisant : ça ne couvrait pas les deux appels qui vivaient AVANT le
// try (idempotence + logger.start()), dont une exception y aurait fait
// sortir de la boucle for et coupé le traitement de toutes les orgs
// suivantes. Root cause trouvée EN ÉCRIVANT ce test — corrigée dans le même
// commit (tout le corps par-org vit désormais dans le try).
//
// Ce fichier invoque le VRAI handler HTTP — stripe-webhook/index.ts::
// handleStripeWebhook, fraîchement exporté (même convention que
// update-stripe-connection::handleUpdateStripeConnection) — avec un client
// Supabase mocké dont l'écriture data_syncs.insert() est configurée pour
// ÉCHOUER spécifiquement pour org-a, et vérifie que org-b progresse quand
// même jusqu'à un data_syncs.sync_status='completed' réel, pas une
// assertion sur l'absence de `return` dans le fichier.

const state = vi.hoisted(() => ({ supabase: null as unknown }))

vi.mock('../functions/_shared/supabase-client.ts', () => ({
  createServiceClient: () => state.supabase,
  jsonResponse: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }),
  errorResponse: (message: string, status = 400) =>
    new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } }),
}))

vi.mock('../functions/_shared/stripe-signature.ts', () => ({
  // La signature HMAC n'est pas ce qu'on teste ici — on suppose déjà
  // vérifiée pour se concentrer sur l'isolation per-org en aval.
  verifyStripeSignature: async () => true,
}))

const dlqCalls: unknown[] = []
const slackCalls: unknown[] = []

vi.mock('../functions/_shared/dlq.ts', () => ({
  writeToDLQ: async (_supabase: unknown, entry: unknown) => { dlqCalls.push(entry) },
}))

vi.mock('../functions/_shared/slack-alert.ts', () => ({
  alertSlack: async (message: string) => { slackCalls.push(message) },
}))

import { handleStripeWebhook } from '../functions/stripe-webhook/index.ts'

interface DataSyncRow {
  id: string
  organization_id: string
  webhook_event_id: string | null
  sync_status: string
  [key: string]: unknown
}

function makeDataSyncsTable(failForOrgId: string) {
  const rows: DataSyncRow[] = []
  let nextId = 1

  const table = {
    insert(row: Record<string, unknown>) {
      return {
        select: () => ({
          single: async () => {
            if (row.organization_id === failForOrgId) {
              // Simule un vrai rejet réseau/serveur — pas un {data:null,
              // error:{...}} avalé en interne par DataSyncLogger.start(),
              // une exception qui se propage réellement.
              throw new Error(`simulated data_syncs insert failure for ${failForOrgId}`)
            }
            const id = `sync-${nextId++}`
            const full: DataSyncRow = { id, sync_status: 'running', ...row } as DataSyncRow
            rows.push(full)
            return { data: { id }, error: null }
          },
        }),
      }
    },
    select() {
      const filters: Array<[string, unknown]> = []
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        eq: (col: string, val: unknown) => { filters.push([col, val]); return chain },
        maybeSingle: async () => {
          const match = rows.find((r) => filters.every(([c, v]) => (r as Record<string, unknown>)[c] === v))
          return { data: match ?? null, error: null }
        },
      }
      return chain
    },
    update(patch: Record<string, unknown>) {
      return {
        eq: (col: string, val: unknown) => {
          const row = rows.find((r) => (r as Record<string, unknown>)[col] === val)
          if (row) Object.assign(row, patch)
          return Promise.resolve({ error: null })
        },
      }
    },
    rows,
  }
  return table
}

function makeSupabaseStub(
  accountsByCustomer: Record<string, string[]>,
  dataSyncsTable: ReturnType<typeof makeDataSyncsTable>,
) {
  return {
    from(table: string) {
      if (table === 'webhook_receipts') {
        return {
          insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'receipt-1' }, error: null }) }) }),
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        }
      }
      if (table === 'accounts') {
        return {
          select: () => ({
            eq: (col: string, val: string) => {
              if (col === 'stripe_customer_id') {
                const ids = accountsByCustomer[val] ?? []
                return Promise.resolve({ data: ids.map((id) => ({ organization_id: id })), error: null })
              }
              return Promise.resolve({ data: [], error: null })
            },
          }),
          upsert: () => ({ select: () => ({ single: async () => ({ data: { id: 'acc-1' }, error: null }) }) }),
        }
      }
      if (table === 'organizations') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
            }),
          }),
        }
      }
      if (table === 'data_syncs') {
        return dataSyncsTable
      }
      throw new Error(`stub: unexpected table ${table}`)
    },
  }
}

function customerCreatedRequest(customerId: string, eventId: string): Request {
  return new Request('http://localhost/stripe-webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'test', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: eventId,
      type: 'customer.created',
      data: { object: { id: customerId, customer: customerId } },
    }),
  })
}

const denoEnv = (globalThis as unknown as { __DENO_ENV__: Record<string, string | undefined> }).__DENO_ENV__

describe('handleStripeWebhook — real handler, per-org failure isolation (fan-out)', () => {
  beforeEach(() => {
    denoEnv.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret'
  })

  it('org A crashing on data_syncs.insert() never stops org B from being fully processed', async () => {
    dlqCalls.length = 0
    slackCalls.length = 0

    const dataSyncsTable = makeDataSyncsTable('org-a')
    state.supabase = makeSupabaseStub({ cus_shared: ['org-a', 'org-b'] }, dataSyncsTable)

    const res = await handleStripeWebhook(customerCreatedRequest('cus_shared', 'evt_isolation_1'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.organizations_processed).toBe(2)
    // handled=true parce qu'AU MOINS une org (org-b) a bien été traitée —
    // ce n'est pas juste "la requête HTTP n'a pas planté".
    expect(body.handled).toBe(true)

    // Preuve directe sur l'état réellement écrit, pas une inférence sur
    // le code : org-b a une ligne data_syncs qui a atteint 'completed'.
    const orgBRow = dataSyncsTable.rows.find((r) => r.organization_id === 'org-b')
    expect(orgBRow).toBeDefined()
    expect(orgBRow?.sync_status).toBe('completed')
    expect(orgBRow?.webhook_event_id).toBe('evt_isolation_1')

    // Org A n'a réussi aucune écriture data_syncs (l'insert lui-même a
    // jeté) — confirmé par l'absence totale de ligne pour cette org,
    // jamais par une supposition.
    expect(dataSyncsTable.rows.find((r) => r.organization_id === 'org-a')).toBeUndefined()

    // L'échec d'org A est bien tracé (DLQ + Slack), pas silencieux.
    expect(dlqCalls).toHaveLength(1)
    expect((dlqCalls[0] as { organization_id: string }).organization_id).toBe('org-a')
    expect(slackCalls).toHaveLength(1)
    expect(slackCalls[0] as string).toContain('org-a')
  })

  it('both orgs succeed when neither fails — baseline sanity check for the stub itself', async () => {
    dlqCalls.length = 0
    const dataSyncsTable = makeDataSyncsTable('org-nonexistent')
    state.supabase = makeSupabaseStub({ cus_shared2: ['org-c', 'org-d'] }, dataSyncsTable)

    const res = await handleStripeWebhook(customerCreatedRequest('cus_shared2', 'evt_isolation_2'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.organizations_processed).toBe(2)
    expect(dataSyncsTable.rows.filter((r) => r.sync_status === 'completed')).toHaveLength(2)
    expect(dlqCalls).toHaveLength(0)
  })

  it('a single org (no sharing) still processes normally through the real handler', async () => {
    const dataSyncsTable = makeDataSyncsTable('org-nonexistent')
    state.supabase = makeSupabaseStub({ cus_solo: ['org-solo'] }, dataSyncsTable)

    const res = await handleStripeWebhook(customerCreatedRequest('cus_solo', 'evt_isolation_3'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.organizations_processed).toBe(1)
    expect(dataSyncsTable.rows[0].sync_status).toBe('completed')
  })
})
