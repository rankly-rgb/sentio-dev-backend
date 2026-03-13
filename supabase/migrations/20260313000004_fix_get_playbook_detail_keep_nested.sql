-- Fix: get_playbook_detail — garder la structure nested de get_playbook_full_detail
-- Le frontend attend data.playbook.id (nested), pas data.id (flat).
-- On garde la structure originale et on ajoute les alias execution_stats/eligible_accounts.

CREATE OR REPLACE FUNCTION public.get_playbook_detail(
  p_playbook_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raw JSON;
  v_result JSON;
BEGIN
  v_raw := public.get_playbook_full_detail(p_playbook_id);

  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;

  -- Garder la structure nested originale + ajouter aliases frontend
  SELECT json_build_object(
    -- Nested playbook (frontend: data.playbook.id, data.playbook.title, etc.)
    'playbook',                    v_raw->'playbook',
    -- Original stats (frontend may use data.stats.executions_total)
    'stats',                       v_raw->'stats',
    -- Alias execution_stats (frontend may use data.execution_stats.total)
    'execution_stats', json_build_object(
      'total',               (v_raw->'stats'->>'executions_total')::integer,
      'total_executions',    (v_raw->'stats'->>'executions_total')::integer,
      'completed',           (v_raw->'stats'->>'executions_completed')::integer,
      'failed',              (v_raw->'stats'->>'executions_failed')::integer,
      'in_progress',         (v_raw->'stats'->>'executions_in_progress')::integer,
      'running',             (v_raw->'stats'->>'executions_in_progress')::integer,
      'pending',             0,
      'targeted_count',      (v_raw->'stats'->>'targeted_count')::integer,
      'reached_count',       (v_raw->'stats'->>'reached_count')::integer,
      'converted_count',     (v_raw->'stats'->>'converted_count')::integer,
      'mrr_recovered_cents', (v_raw->'stats'->>'mrr_recovered_cents')::integer,
      'mrr_expansion_cents', (v_raw->'stats'->>'mrr_expansion_cents')::integer,
      'last_executed_at',    v_raw->'playbook'->'last_executed_at'
    ),
    -- Original affected_accounts_summary
    'affected_accounts_summary',   v_raw->'affected_accounts_summary',
    -- Alias eligible_accounts (frontend may use data.eligible_accounts.total)
    'eligible_accounts', json_build_object(
      'total',             (v_raw->'affected_accounts_summary'->>'total')::integer,
      'mrr_at_risk_cents', (v_raw->'affected_accounts_summary'->>'mrr_at_risk_cents')::integer,
      'by_urgency',        v_raw->'affected_accounts_summary'->'by_urgency',
      'urgent_count',      (v_raw->'affected_accounts_summary'->'by_urgency'->>'urgent')::integer,
      'surveiller_count',  (v_raw->'affected_accounts_summary'->'by_urgency'->>'watch')::integer,
      'stable_count',      (v_raw->'affected_accounts_summary'->'by_urgency'->>'stable')::integer
    ),
    -- Scalar alias
    'current_eligible_count',      (v_raw->'stats'->>'eligible_count')::integer,
    -- Raw conditions and actions
    'conditions',                  v_raw->'conditions',
    'actions',                     v_raw->'actions'
  )
  INTO v_result;

  RETURN v_result;
END;
$$;
