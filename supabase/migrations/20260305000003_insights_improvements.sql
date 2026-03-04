-- ============================================================
-- Migration : AI Insights improvements
-- 1. Fix ON DELETE SET NULL → ON DELETE CASCADE (no orphaned insights)
-- 2. Unique partial index for deduplication (1 active insight per org+account+type)
-- 3. Add source_scores JSONB column for traceability
-- ============================================================

-- 1. Fix foreign key: drop old FK, add CASCADE
ALTER TABLE public.ai_insights
  DROP CONSTRAINT IF EXISTS ai_insights_account_id_fkey;

ALTER TABLE public.ai_insights
  ADD CONSTRAINT ai_insights_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;

-- 2. Unique partial index: 1 active insight per (org, account, type)
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_insights_active_dedup
  ON public.ai_insights (organization_id, account_id, insight_type)
  WHERE status = 'active';

-- 3. Add source_scores column for traceability
ALTER TABLE public.ai_insights
  ADD COLUMN IF NOT EXISTS source_scores JSONB NULL;

-- 4. Add data_syncs source value for insights
ALTER TABLE public.data_syncs
  DROP CONSTRAINT IF EXISTS data_syncs_sync_source_check;

ALTER TABLE public.data_syncs
  ADD CONSTRAINT data_syncs_sync_source_check
  CHECK (sync_source = ANY (ARRAY['stripe', 'hubspot', 'usage', 'manual', 'scoring', 'insights']));
