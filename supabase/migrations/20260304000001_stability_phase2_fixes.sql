-- ============================================================
-- Migration: stability_phase2_fixes
-- Fixes CHECK constraint on data_syncs.error_type to include 'timeout'
-- Required by self-monitor auto-fail of stuck syncs
-- ============================================================

-- Widen data_syncs.error_type CHECK to include 'timeout'
ALTER TABLE data_syncs DROP CONSTRAINT IF EXISTS data_syncs_error_type_check;
ALTER TABLE data_syncs ADD CONSTRAINT data_syncs_error_type_check
  CHECK (error_type IS NULL OR error_type = ANY(ARRAY['api_error','network_error','validation_error','rate_limit','auth_error','timeout']));

-- Add unique constraint for segment_memberships upsert (org + segment + account)
-- Used by calculate-scores atomic upsert instead of delete+insert
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'segment_memberships_org_segment_account_unique'
  ) THEN
    ALTER TABLE segment_memberships
      ADD CONSTRAINT segment_memberships_org_segment_account_unique
      UNIQUE (organization_id, segment_id, account_id);
  END IF;
END $$;
