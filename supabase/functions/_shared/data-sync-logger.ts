import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export type SyncStatus = 'pending' | 'running' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled' | 'rate_limited'
export type SyncSource = 'stripe' | 'hubspot' | 'usage' | 'manual' | 'scoring' | 'insights'
export type SyncType = 'initial' | 'incremental' | 'webhook' | 'daily' | 'full_sync'

// Incident 2026-08-04 (IMPLEMENTATION_LOG.md, régression PR MRR engine v2) :
// batchUpsert() (sync-stripe/index.ts) capturait déjà error.message/code sur
// chaque batch en échec, mais seulement via console.error — jeté ensuite,
// jamais remonté à DataSyncLogger. complete() se déclarait 'completed' sans
// condition, error_message restait NULL malgré 422 échecs réels. Ce type
// existe pour que l'appelant puisse transmettre l'erreur Postgres réelle à
// complete(), qui décide alors du statut à partir de records_failed au lieu
// de toujours écrire 'completed'.
export interface WriteError {
  table: string
  message: string
  code: string | null
}

interface SyncLoggerOptions {
  supabase: SupabaseClient
  organizationId: string
  syncSource: SyncSource
  syncType: SyncType
  triggeredBy?: string
  webhookEventId?: string
  isManual?: boolean
}

export class DataSyncLogger {
  private supabase: SupabaseClient
  private syncId: string | null = null
  private organizationId: string
  private syncSource: SyncSource
  private syncType: SyncType
  private triggeredBy: string
  private webhookEventId: string | null
  private isManual: boolean
  private startedAt: Date | null = null

  private counts = {
    records_processed: 0,
    records_created: 0,
    records_updated: 0,
    records_failed: 0,
    accounts_processed: 0,
    subscriptions_processed: 0,
    invoices_processed: 0,
    movements_processed: 0,
    usage_events_processed: 0,
    companies_processed: 0,
    api_calls_made: 0,
  }

  constructor(opts: SyncLoggerOptions) {
    this.supabase = opts.supabase
    this.organizationId = opts.organizationId
    this.syncSource = opts.syncSource
    this.syncType = opts.syncType
    this.triggeredBy = opts.triggeredBy ?? 'system'
    this.webhookEventId = opts.webhookEventId ?? null
    this.isManual = opts.isManual ?? false
  }

  async start(): Promise<void> {
    this.startedAt = new Date()
    const { data, error } = await this.supabase
      .from('data_syncs')
      .insert({
        organization_id: this.organizationId,
        sync_source: this.syncSource,
        sync_type: this.syncType,
        sync_status: 'running',
        triggered_by: this.triggeredBy,
        webhook_event_id: this.webhookEventId,
        is_manual: this.isManual,
        started_at: this.startedAt.toISOString(),
      })
      .select('id')
      .single()

    if (error) {
      console.error('[DataSyncLogger] Failed to create sync record:', error.message)
    } else {
      this.syncId = data.id
    }
  }

  increment(field: keyof typeof this.counts, by = 1): void {
    this.counts[field] += by
  }

  // writeErrors : détails Postgres réels des batchs en échec, collectés par
  // l'appelant (ex. sync-stripe/index.ts) au fil du run. Détermine le statut
  // final à partir de records_failed plutôt que de toujours écrire
  // 'completed' — voir le commentaire sur WriteError ci-dessus.
  async complete(summary?: Record<string, unknown>, writeErrors: WriteError[] = []): Promise<void> {
    if (!this.syncId) return
    const completedAt = new Date()
    const durationSeconds = this.startedAt
      ? Math.round((completedAt.getTime() - this.startedAt.getTime()) / 1000)
      : null

    const failed = this.counts.records_failed
    const processed = this.counts.records_processed
    // failed=0 → completed. failed>0 mais du travail a quand même abouti →
    // completed_with_errors (dégradé, pas un échec total — un opérateur doit
    // le voir sans que ça se confonde avec 'failed', réservé aux runs qui
    // n'ont RIEN pu écrire). failed>0 et processed=0 → failed, un échec total
    // déguisé en succès est le problème exact que ce correctif élimine.
    const status: SyncStatus = failed === 0 ? 'completed' : processed > 0 ? 'completed_with_errors' : 'failed'

    const update: Record<string, unknown> = {
      sync_status: status,
      completed_at: completedAt.toISOString(),
      duration_seconds: durationSeconds,
      sync_summary: summary ?? null,
      ...this.counts,
    }
    if (status !== 'completed') {
      update.error_message = writeErrors.length > 0
        ? writeErrors.map((e) => `${e.table}: ${e.message}${e.code ? ` (${e.code})` : ''}`).join(' | ').slice(0, 2000)
        : `${failed} record(s) failed to write — no structured error captured`
      update.error_type = 'write_error'
      update.is_retryable = true
    }

    try {
      const { error } = await this.supabase
        .from('data_syncs')
        .update(update)
        .eq('id', this.syncId)

      if (error) {
        console.error('[DataSyncLogger] complete() UPDATE failed:', error.message, error.code, JSON.stringify(this.counts))
      }
    } catch (err) {
      console.error('[DataSyncLogger] complete() threw:', err instanceof Error ? err.message : String(err))
    }
  }

  async fail(errorMessage: string, errorType = 'api_error', isRetryable = true): Promise<void> {
    if (!this.syncId) return
    try {
      const completedAt = new Date()
      const durationSeconds = this.startedAt
        ? Math.round((completedAt.getTime() - this.startedAt.getTime()) / 1000)
        : null

      await this.supabase
        .from('data_syncs')
        .update({
          sync_status: 'failed',
          completed_at: completedAt.toISOString(),
          duration_seconds: durationSeconds,
          error_message: errorMessage,
          error_type: errorType,
          is_retryable: isRetryable,
          ...this.counts,
        })
        .eq('id', this.syncId)
    } catch (err) {
      console.error('[DataSyncLogger] fail() threw:', err instanceof Error ? err.message : String(err))
    }
  }
}
