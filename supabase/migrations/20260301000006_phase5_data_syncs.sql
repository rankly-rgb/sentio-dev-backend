-- ============================================================
-- Migration 006 : Phase 5 — Infrastructure technique
-- Table : data_syncs
-- ============================================================

-- ------------------------------------------------------------
-- 5.1 data_syncs — Journal des synchronisations
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.data_syncs (
  id                   UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  sync_source          TEXT NOT NULL,
  sync_type            TEXT NOT NULL,
  sync_status          TEXT NOT NULL DEFAULT 'pending',

  records_processed    INTEGER NULL DEFAULT 0,
  records_created      INTEGER NULL DEFAULT 0,
  records_updated      INTEGER NULL DEFAULT 0,
  records_failed       INTEGER NULL DEFAULT 0,

  -- Détail par entité
  accounts_processed      INTEGER NULL DEFAULT 0,
  subscriptions_processed INTEGER NULL DEFAULT 0,
  invoices_processed      INTEGER NULL DEFAULT 0,
  movements_processed     INTEGER NULL DEFAULT 0,
  usage_events_processed  INTEGER NULL DEFAULT 0,
  companies_processed     INTEGER NULL DEFAULT 0,

  -- Pagination / cursor
  total_pages             INTEGER NULL,
  current_page            INTEGER NULL,
  cursor_token            TEXT NULL,
  last_synced_record_date TIMESTAMPTZ NULL,

  -- API
  api_calls_made              INTEGER NULL DEFAULT 0,
  api_rate_limit_remaining    INTEGER NULL,
  api_rate_limit_reset_at     TIMESTAMPTZ NULL,

  -- Erreurs
  error_message    TEXT NULL,
  error_type       TEXT NULL,
  retry_count      INTEGER NULL DEFAULT 0,
  max_retries      INTEGER NULL DEFAULT 3,
  next_retry_at    TIMESTAMPTZ NULL,
  is_retryable     BOOLEAN NULL DEFAULT TRUE,

  -- Déclencheur
  triggered_by         TEXT NULL,
  triggered_by_user    UUID NULL REFERENCES public.profiles_(id) ON DELETE SET NULL,
  webhook_event_id     TEXT NULL,
  is_manual            BOOLEAN NULL DEFAULT FALSE,

  started_at           TIMESTAMPTZ NULL,
  completed_at         TIMESTAMPTZ NULL,
  duration_seconds     INTEGER NULL,
  next_scheduled_sync  TIMESTAMPTZ NULL,

  sync_config          JSONB NULL,
  sync_summary         JSONB NULL,
  data_quality_score   NUMERIC(5,2) NULL,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT data_syncs_pkey PRIMARY KEY (id),
  CONSTRAINT data_syncs_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT data_syncs_sync_source_check CHECK (
    sync_source = ANY (ARRAY['stripe','hubspot','usage','manual'])
  ),
  CONSTRAINT data_syncs_sync_type_check CHECK (
    sync_type = ANY (ARRAY['initial','incremental','webhook','daily','full_sync'])
  ),
  CONSTRAINT data_syncs_sync_status_check CHECK (
    sync_status = ANY (ARRAY['pending','running','completed','failed','cancelled','rate_limited'])
  ),
  CONSTRAINT data_syncs_error_type_check CHECK (
    error_type = ANY (ARRAY['api_error','network_error','validation_error','rate_limit','auth_error'])
    OR error_type IS NULL
  ),
  CONSTRAINT data_syncs_timing_check CHECK (
    completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at
  ),
  CONSTRAINT data_syncs_records_coherence_check CHECK (
    records_processed >= (
      COALESCE(records_created, 0)
      + COALESCE(records_updated, 0)
      + COALESCE(records_failed, 0)
    )
    OR records_processed IS NULL
  )
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_data_syncs_org ON public.data_syncs USING btree (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_syncs_status ON public.data_syncs USING btree (organization_id, sync_status);
CREATE INDEX IF NOT EXISTS idx_data_syncs_source ON public.data_syncs USING btree (sync_source, sync_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_syncs_pending ON public.data_syncs USING btree (next_scheduled_sync)
  WHERE sync_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_data_syncs_retry ON public.data_syncs USING btree (next_retry_at)
  WHERE is_retryable = TRUE AND retry_count < max_retries;

DROP TRIGGER IF EXISTS update_data_syncs_updated_at ON public.data_syncs;
CREATE TRIGGER update_data_syncs_updated_at
  BEFORE UPDATE ON public.data_syncs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.data_syncs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "data_syncs_org_isolation" ON public.data_syncs;
CREATE POLICY "data_syncs_org_isolation"
ON public.data_syncs FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);
