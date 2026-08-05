import { describe, it, expect } from 'vitest'
import { DataSyncLogger, type WriteError } from '../functions/_shared/data-sync-logger'

// Bug trouvé le 2026-08-04 (IMPLEMENTATION_LOG.md, incident restatement) :
// complete() écrivait sync_status='completed' sans condition, quel que soit
// records_failed — un run avec 422 échecs d'écriture accounts (contrainte
// NOT NULL violée sur billing_model) se déclarait "completed",
// error_message NULL, l'erreur Postgres réelle jetée par batchUpsert
// (console.error seulement, jamais persistée). Exactement le pattern de
// succès silencieux que ce chantier existait pour éliminer.

type CapturedUpdate = Record<string, unknown>

function mockSupabase(captured: CapturedUpdate[]) {
  return {
    from: (_table: string) => ({
      insert: (_row: Record<string, unknown>) => ({
        select: () => ({
          single: () => Promise.resolve({ data: { id: 'sync-1' }, error: null }),
        }),
      }),
      update: (payload: CapturedUpdate) => {
        captured.push(payload)
        return { eq: () => Promise.resolve({ error: null }) }
      },
    }),
  } as unknown as ConstructorParameters<typeof DataSyncLogger>[0]['supabase']
}

async function runLogger(opts: {
  recordsProcessed: number
  recordsFailed: number
  writeErrors?: WriteError[]
}): Promise<CapturedUpdate> {
  const captured: CapturedUpdate[] = []
  const logger = new DataSyncLogger({
    supabase: mockSupabase(captured),
    organizationId: 'org-1',
    syncSource: 'stripe',
    syncType: 'incremental',
  })
  await logger.start()
  logger.increment('records_processed', opts.recordsProcessed)
  logger.increment('records_failed', opts.recordsFailed)
  await logger.complete({ sync_type: 'incremental' }, opts.writeErrors ?? [])
  return captured[captured.length - 1]
}

describe('DataSyncLogger.complete — status reflects records_failed (no more silent success)', () => {
  it('records_failed=0 → completed, no error_message written', async () => {
    const update = await runLogger({ recordsProcessed: 100, recordsFailed: 0 })
    expect(update.sync_status).toBe('completed')
    expect(update.error_message).toBeUndefined()
    expect(update.error_type).toBeUndefined()
  })

  it('REGRESSION: records_failed>0 with some records_processed → completed_with_errors, not completed', async () => {
    const update = await runLogger({
      recordsProcessed: 333,
      recordsFailed: 422,
      writeErrors: [{ table: 'accounts', message: 'null value in column "billing_model" of relation "accounts" violates not-null constraint', code: '23502' }],
    })
    expect(update.sync_status).toBe('completed_with_errors')
    expect(update.error_message).toContain('billing_model')
    expect(update.error_message).toContain('23502')
    expect(update.error_type).toBe('write_error')
  })

  it('REGRESSION: records_failed>0 and records_processed=0 (total write failure) → failed, not completed', async () => {
    const update = await runLogger({ recordsProcessed: 0, recordsFailed: 422 })
    expect(update.sync_status).toBe('failed')
    expect(update.error_message).toContain('422 record(s) failed to write')
  })

  it('multiple write errors from different tables are all captured, not just the last one', async () => {
    const update = await runLogger({
      recordsProcessed: 10,
      recordsFailed: 5,
      writeErrors: [
        { table: 'accounts', message: 'null value in column "billing_model"', code: '23502' },
        { table: 'mrr_restatements', message: 'duplicate key value', code: '23505' },
      ],
    })
    expect(update.error_message).toContain('accounts:')
    expect(update.error_message).toContain('mrr_restatements:')
  })
})
