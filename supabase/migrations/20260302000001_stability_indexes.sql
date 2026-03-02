-- ============================================================
-- Migration 007 : Stability — Performance indexes
-- Adds indexes for monitoring queries, scoring batch queries,
-- and DLQ/cron management.
-- All statements are idempotent (IF NOT EXISTS).
-- ============================================================

-- Index for DLQ monitoring queries (recent entries)
CREATE INDEX IF NOT EXISTS idx_wdl_created
  ON public.webhook_dead_letter USING btree (created_at DESC);

-- Index for DLQ provider + retry status
CREATE INDEX IF NOT EXISTS idx_wdl_provider_retry
  ON public.webhook_dead_letter USING btree (provider, retry_count);

-- Index for cron lock TTL checks
CREATE INDEX IF NOT EXISTS idx_cron_locks_key_expires
  ON public.cron_locks USING btree (lock_key, expires_at);

-- Index for data_syncs monitoring (status + source)
CREATE INDEX IF NOT EXISTS idx_data_syncs_status_source
  ON public.data_syncs USING btree (sync_status, sync_source);

-- Partial index for stuck running syncs
CREATE INDEX IF NOT EXISTS idx_data_syncs_running
  ON public.data_syncs USING btree (started_at)
  WHERE sync_status = 'running';

-- Index for scoring batch: usage_events per account + date range
CREATE INDEX IF NOT EXISTS idx_usage_events_account_date
  ON public.usage_events USING btree (account_id, event_date);

-- Index for scoring batch: invoices per account + status
CREATE INDEX IF NOT EXISTS idx_invoices_account_status
  ON public.invoices USING btree (account_id, status);

-- Index for scoring batch: hubspot_companies per account
CREATE INDEX IF NOT EXISTS idx_hubspot_companies_account
  ON public.hubspot_companies USING btree (account_id);

-- Index for score_history freshness check
CREATE INDEX IF NOT EXISTS idx_score_history_date
  ON public.score_history USING btree (organization_id, snapshot_date DESC);
