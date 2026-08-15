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

// ── Incident 2026-08-15 : un UPDATE de complétion rejeté laissait la ligne
// à 'running' pour toujours ──
//
// error_type='write_error' (écrit depuis le 2026-08-04) n'a jamais figuré dans
// data_syncs_error_type_check. Tout run avec records_failed>0 voyait donc son
// UPDATE rejeté en bloc (23514), la ligne restait 'running', et self-monitor la
// marquait 15 min plus tard « exceeded 15 min running time » — un diagnostic
// faux : le sync avait terminé en 27 secondes. Mesure avant correctif : ZÉRO
// ligne 'completed_with_errors' sur 1938 syncs depuis mars 2026.
//
// La migration 20260815000001 ajoute la valeur manquante ; ces tests couvrent
// le filet applicatif, qui doit tenir pour TOUT rejet, pas seulement celui-là.

function mockSupabaseRejectingFirstUpdate(captured: CapturedUpdate[], rejection: { message: string; code: string }) {
  let updateCount = 0
  return {
    from: (_table: string) => ({
      insert: () => ({
        select: () => ({ single: () => Promise.resolve({ data: { id: 'sync-1' }, error: null }) }),
      }),
      update: (payload: CapturedUpdate) => {
        captured.push(payload)
        updateCount += 1
        // Le premier UPDATE (complet, avec error_type) est rejeté ; le
        // repli (sans error_type) passe.
        const error = updateCount === 1 ? rejection : null
        return { eq: () => Promise.resolve({ error }) }
      },
    }),
  } as unknown as ConstructorParameters<typeof DataSyncLogger>[0]['supabase']
}

describe('DataSyncLogger.complete — a rejected status write must never leave the row running', () => {
  async function runWithRejection() {
    const captured: CapturedUpdate[] = []
    const logger = new DataSyncLogger({
      supabase: mockSupabaseRejectingFirstUpdate(captured, {
        message: 'new row for relation "data_syncs" violates check constraint "data_syncs_error_type_check"',
        code: '23514',
      }),
      organizationId: 'org-1',
      syncSource: 'stripe',
      syncType: 'full_sync',
    })
    await logger.start()
    logger.increment('records_processed', 367)
    logger.increment('records_failed', 189)
    await logger.complete({}, [{ table: 'invoices', message: 'no matching account', code: null }])
    return captured
  }

  it('REGRESSION: retries with a safe payload when the first UPDATE is rejected', async () => {
    const captured = await runWithRejection()
    expect(captured).toHaveLength(2)
  })

  it('REGRESSION: the retry still writes a TERMINAL status, never leaving sync_status=running', async () => {
    const captured = await runWithRejection()
    const retry = captured[1]
    // Le statut dégradé exact est préservé — le repli ne dégrade pas
    // 'completed_with_errors' en 'failed', ce qui ferait passer un run
    // partiellement réussi pour un échec total.
    expect(retry.sync_status).toBe('completed_with_errors')
    expect(retry.completed_at).toBeTruthy()
    expect(retry.sync_status).not.toBe('running')
  })

  it('the retry drops error_type — the column that caused the rejection', async () => {
    const captured = await runWithRejection()
    expect(captured[0].error_type).toBe('write_error')
    expect(captured[1].error_type).toBeUndefined()
  })

  it('the retry preserves the original diagnostic AND names the rejection reason', async () => {
    const captured = await runWithRejection()
    const message = captured[1].error_message as string
    expect(message).toContain('invoices:')
    expect(message).toContain('no matching account')
    expect(message).toContain('data_syncs_error_type_check')
  })

  it('error_message stays within the 2000-char column budget even after the retry suffix', async () => {
    const captured: CapturedUpdate[] = []
    const logger = new DataSyncLogger({
      supabase: mockSupabaseRejectingFirstUpdate(captured, { message: 'x'.repeat(3000), code: '23514' }),
      organizationId: 'org-1',
      syncSource: 'stripe',
      syncType: 'full_sync',
    })
    await logger.start()
    logger.increment('records_processed', 1)
    logger.increment('records_failed', 1)
    await logger.complete({}, [{ table: 'invoices', message: 'y'.repeat(3000), code: null }])
    expect((captured[1].error_message as string).length).toBeLessThanOrEqual(2000)
  })
})
