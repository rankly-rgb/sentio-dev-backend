-- Migration: Add 'pending_approval' to playbook_executions.execution_status CHECK
-- Required for semi_automated playbook human-in-the-loop approval flow

ALTER TABLE playbook_executions
  DROP CONSTRAINT IF EXISTS playbook_executions_execution_status_check;

ALTER TABLE playbook_executions
  ADD CONSTRAINT playbook_executions_execution_status_check
  CHECK (execution_status IN ('pending', 'pending_approval', 'running', 'completed', 'failed', 'cancelled', 'partially_completed'));
