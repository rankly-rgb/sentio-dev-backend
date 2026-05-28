-- Fonction atomique pour incrémenter les KPI d'un playbook
-- Remplace le pattern read-then-write non atomique dans playbook-execute et playbook-scheduler
CREATE OR REPLACE FUNCTION increment_playbook_kpis(
  p_playbook_id      UUID,
  p_accounts_eligible INT,
  p_accounts_targeted INT,
  p_accounts_reached  INT
) RETURNS VOID
LANGUAGE SQL
AS $$
  UPDATE playbooks SET
    accounts_eligible = COALESCE(accounts_eligible, 0) + p_accounts_eligible,
    accounts_targeted = COALESCE(accounts_targeted, 0) + p_accounts_targeted,
    accounts_reached  = COALESCE(accounts_reached,  0) + p_accounts_reached,
    execution_count   = COALESCE(execution_count,   0) + 1,
    last_executed_at  = now()
  WHERE id = p_playbook_id;
$$;
