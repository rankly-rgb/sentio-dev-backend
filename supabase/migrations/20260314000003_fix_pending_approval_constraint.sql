-- Migration: Fix pending_approval CHECK constraint on playbook_executions
--
-- Root cause: Migration 20260312000002 tried to DROP constraint named
-- 'playbook_executions_execution_status_check' but the actual constraint
-- was named 'playbook_executions_status_check'. The DROP silently succeeded
-- (IF EXISTS), and the ADD created a NEW constraint with the correct values
-- but the OLD constraint (without pending_approval) remained, blocking inserts.
--
-- Fix: Drop BOTH constraint names (old and new), then recreate with the
-- correct name and all valid statuses including pending_approval.

-- Drop the old constraint (the one actually blocking inserts)
ALTER TABLE playbook_executions
  DROP CONSTRAINT IF EXISTS playbook_executions_status_check;

-- Drop the new constraint added by 20260312000002 (if it exists)
ALTER TABLE playbook_executions
  DROP CONSTRAINT IF EXISTS playbook_executions_execution_status_check;

-- Recreate with all valid statuses
ALTER TABLE playbook_executions
  ADD CONSTRAINT playbook_executions_status_check
  CHECK (execution_status IN ('pending', 'pending_approval', 'running', 'completed', 'failed', 'cancelled', 'partially_completed'));
