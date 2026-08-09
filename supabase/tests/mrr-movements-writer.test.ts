import { describe, it, expect } from 'vitest'
import { dedupeMovementRows, writeMrrMovementsSync, type MrrMovementSyncRow } from '../functions/_shared/mrr-movements-writer'
import { DataSyncLogger, type WriteError } from '../functions/_shared/data-sync-logger'

// Root cause (docs/CHANGELOG_STABILITY.md, 2026-08-08) : sync-stripe's
// .upsert() on mrr_movements targeted an ON CONFLICT that could never
// match the partial unique index mrr_movements_sync_idempotency (WHERE
// stripe_event_id IS NULL) — every write failed with 42P10, silently,
// since the table's creation (2026-07-05). writeMrrMovementsSync replaces
// the PostgREST .upsert() with a native RPC (migration 20260808000001)
// that expresses the WHERE predicate Postgres actually requires as the
// ON CONFLICT arbiter.

const row: MrrMovementSyncRow = {
  organization_id: 'org-1',
  account_id: 'acct-1',
  movement_type: 'churn',
  amount_cents: -4900,
  movement_date: '2026-08-08',
}

describe('dedupeMovementRows', () => {
  it('collapses two identical (org, account, date, type) rows generated in the same run', () => {
    // Reproduces the real trigger: customerToAccount (sync-stripe) is a
    // Map<stripe_customer_id, account_id> — two distinct stripe_customer_id
    // pointing at the same account_id (duplicate account data, cf. commit
    // 4325aa6 "fix(data): supprimer doublons display_name dans accounts")
    // makes the movement-generation loop push the same tuple twice before
    // any DB round-trip.
    const deduped = dedupeMovementRows([row, { ...row }])
    expect(deduped).toHaveLength(1)
  })

  it('keeps distinct movement_type rows for the same account/date', () => {
    const deduped = dedupeMovementRows([row, { ...row, movement_type: 'expansion', amount_cents: 500 }])
    expect(deduped).toHaveLength(2)
  })

  it('keeps rows from different accounts untouched', () => {
    const deduped = dedupeMovementRows([row, { ...row, account_id: 'acct-2' }])
    expect(deduped).toHaveLength(2)
  })

  it('empty input stays empty', () => {
    expect(dedupeMovementRows([])).toEqual([])
  })
})

function mockRpcSupabase(result: { error: { message: string; code?: string } | null }) {
  return {
    rpc: (_fn: string, _args: Record<string, unknown>) => Promise.resolve(result),
  } as unknown as Parameters<typeof writeMrrMovementsSync>[0]
}

describe('writeMrrMovementsSync', () => {
  it('empty input: no RPC call, zero processed/failed, no writeError', async () => {
    let called = false
    const supabase = {
      rpc: () => {
        called = true
        return Promise.resolve({ error: null })
      },
    } as unknown as Parameters<typeof writeMrrMovementsSync>[0]

    const result = await writeMrrMovementsSync(supabase, [])
    expect(result).toEqual({ processed: 0, failed: 0, writeError: null })
    expect(called).toBe(false)
  })

  it('RPC succeeds: all rows reported processed, no writeError', async () => {
    const supabase = mockRpcSupabase({ error: null })
    const result = await writeMrrMovementsSync(supabase, [row, { ...row, account_id: 'acct-2' }])
    expect(result).toEqual({ processed: 2, failed: 0, writeError: null })
  })

  it('REGRESSION: RPC fails (e.g. 42P10, the real bug) — all rows reported failed, writeError captures the real Postgres error', async () => {
    const supabase = mockRpcSupabase({
      error: { message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification', code: '42P10' },
    })
    const result = await writeMrrMovementsSync(supabase, [row, { ...row, account_id: 'acct-2' }])
    expect(result.processed).toBe(0)
    expect(result.failed).toBe(2)
    expect(result.writeError).toEqual({
      table: 'mrr_movements',
      message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification',
      code: '42P10',
    })
  })

  it('RPC fails without a code: writeError.code falls back to null, never undefined', async () => {
    const supabase = mockRpcSupabase({ error: { message: 'boom' } })
    const result = await writeMrrMovementsSync(supabase, [row])
    expect(result.writeError?.code).toBeNull()
  })

  // Vérification pré-merge PR #45, point 3 : un doublon (org, account_id,
  // movement_date, movement_type) volontairement ignoré par `ON CONFLICT
  // ... DO NOTHING` à l'intérieur du RPC N'EST PAS une erreur Postgres —
  // la clause supprime l'exception à la source, avant même que
  // supabase.rpc() ne reçoive une réponse. Vérifié empiriquement contre
  // une vraie instance Postgres 17 (schéma jetable, reproduisant
  // exactement le corps du RPC + l'index partiel réel) : deux appels
  // consécutifs avec la même ligne renvoient tous deux { error: null }, le
  // compte de lignes ne bouge qu'une fois. Un VRAI échec d'écriture (ex.
  // CHECK constraint sur movement_type, reproduit avec succès dans la même
  // vérification : ERROR 23514) est fondamentalement différent : il fait
  // échouer TOUT le statement INSERT (all-or-nothing, une seule
  // instruction SQL pour tout le batch), donc supabase.rpc() reçoit un
  // { error } non-null — c'est uniquement CE cas que writeMrrMovementsSync
  // traduit en failed/writeError. Il n'y a donc aucun chemin par lequel un
  // doublon légitime pourrait faire remonter records_failed > 0 : le mock
  // ci-dessous représente fidèlement ce que fait réellement le RPC pour un
  // doublon (jamais d'erreur, quel que soit le nombre de lignes
  // effectivement no-op côté SQL).
  it('a legitimate duplicate (already-written tuple) is a silent no-op at the SQL level, never surfaces as failed/writeError', async () => {
    const supabase = mockRpcSupabase({ error: null }) // DO NOTHING → pas d'exception → { error: null }, exactement comme un insert neuf
    const result = await writeMrrMovementsSync(supabase, [row])
    expect(result).toEqual({ processed: 1, failed: 0, writeError: null })
  })
})

// finding #2 : la même DataSyncLogger.complete() déjà testée en isolation
// (data-sync-logger.test.ts) doit refléter un échec d'écriture mrr_movements
// exactement comme elle reflète déjà un échec batchUpsert accounts —
// composé ici de bout en bout avec writeMrrMovementsSync, sans avoir besoin
// d'importer sync-stripe/index.ts (imports jsr: runtime non résolvables par
// Vitest).
describe('mrr_movements write failure drives DataSyncLogger away from a silent "completed"', () => {
  function mockLoggerSupabase(captured: Record<string, unknown>[]) {
    return {
      from: (_table: string) => ({
        insert: (_row: Record<string, unknown>) => ({
          select: () => ({
            single: () => Promise.resolve({ data: { id: 'sync-1' }, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          captured.push(payload)
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }),
    } as unknown as ConstructorParameters<typeof DataSyncLogger>[0]['supabase']
  }

  it('a total mrr_movements write failure (no other work in this org run) drives sync_status to failed, not completed', async () => {
    const rpcSupabase = mockRpcSupabase({ error: { message: 'no unique or exclusion constraint matching the ON CONFLICT specification', code: '42P10' } })
    const { failed, writeError } = await writeMrrMovementsSync(rpcSupabase, [row])

    const captured: Record<string, unknown>[] = []
    const logger = new DataSyncLogger({
      supabase: mockLoggerSupabase(captured),
      organizationId: 'org-1',
      syncSource: 'stripe',
      syncType: 'daily',
    })
    await logger.start()
    logger.increment('records_failed', failed)
    const writeErrors: WriteError[] = writeError ? [writeError] : []
    await logger.complete({ sync_type: 'daily' }, writeErrors)

    const update = captured[captured.length - 1]
    expect(update.sync_status).toBe('failed')
    expect(update.error_message).toContain('42P10')
    expect(update.error_message).toContain('mrr_movements')
  })

  it('a partial mrr_movements failure alongside other successful work (accounts/subscriptions/invoices synced fine) drives completed_with_errors, not completed', async () => {
    const rpcSupabase = mockRpcSupabase({ error: { message: 'boom', code: 'XXYYY' } })
    const { failed, writeError } = await writeMrrMovementsSync(rpcSupabase, [row])

    const captured: Record<string, unknown>[] = []
    const logger = new DataSyncLogger({
      supabase: mockLoggerSupabase(captured),
      organizationId: 'org-1',
      syncSource: 'stripe',
      syncType: 'daily',
    })
    await logger.start()
    logger.increment('records_processed', 50)
    logger.increment('records_failed', failed)
    await logger.complete({ sync_type: 'daily' }, writeError ? [writeError] : [])

    const update = captured[captured.length - 1]
    expect(update.sync_status).toBe('completed_with_errors')
    expect(update.error_message).toContain('mrr_movements')
  })
})
