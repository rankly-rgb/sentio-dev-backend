-- ============================================================
-- Migration : stability_phase3_4
-- Phase 4 : Database hardening — CASCADE FKs, CHECK constraints,
--           stuck execution monitoring support
-- ============================================================

-- 1. ON DELETE CASCADE on profiles_.organization_id FK
-- (prevents orphaned profiles when org is deleted)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'profiles__organization_id_fkey'
    AND table_name = 'profiles_'
  ) THEN
    ALTER TABLE profiles_ DROP CONSTRAINT profiles__organization_id_fkey;
    ALTER TABLE profiles_ ADD CONSTRAINT profiles__organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 2. CHECK constraint on playbooks.status
ALTER TABLE playbooks DROP CONSTRAINT IF EXISTS playbooks_status_check;
ALTER TABLE playbooks ADD CONSTRAINT playbooks_status_check
  CHECK (status = ANY(ARRAY['draft', 'active', 'paused', 'archived']));

-- 3. CHECK constraint on playbook_executions.execution_status
ALTER TABLE playbook_executions DROP CONSTRAINT IF EXISTS playbook_executions_status_check;
ALTER TABLE playbook_executions ADD CONSTRAINT playbook_executions_status_check
  CHECK (execution_status = ANY(ARRAY['pending', 'running', 'completed', 'failed', 'partially_completed', 'cancelled']));

-- 4. Index for self-monitor stuck execution detection
CREATE INDEX IF NOT EXISTS idx_playbook_executions_stuck
  ON playbook_executions (execution_status, started_at)
  WHERE execution_status = 'running';

-- 5. Index for health endpoint org count
CREATE INDEX IF NOT EXISTS idx_organizations_active
  ON organizations (id)
  WHERE id IS NOT NULL;
