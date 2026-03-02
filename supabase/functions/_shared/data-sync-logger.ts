import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export type SyncStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'rate_limited'
export type SyncSource = 'stripe' | 'hubspot' | 'usage' | 'manual' | 'scoring'
export type SyncType = 'initial' | 'incremental' | 'webhook' | 'daily' | 'full_sync'

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

  async complete(summary?: Record<string, unknown>): Promise<void> {
    if (!this.syncId) return
    const completedAt = new Date()
    const durationSeconds = this.startedAt
      ? Math.round((completedAt.getTime() - this.startedAt.getTime()) / 1000)
      : null

    await this.supabase
      .from('data_syncs')
      .update({
        sync_status: 'completed',
        completed_at: completedAt.toISOString(),
        duration_seconds: durationSeconds,
        sync_summary: summary ?? null,
        ...this.counts,
      })
      .eq('id', this.syncId)
  }

  async fail(errorMessage: string, errorType = 'api_error', isRetryable = true): Promise<void> {
    if (!this.syncId) return
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
  }
}
