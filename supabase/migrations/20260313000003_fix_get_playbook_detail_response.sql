-- Fix: get_playbook_detail — remapper la réponse pour le frontend
-- Le frontend attend execution_stats.total et eligible_accounts.total
-- mais get_playbook_full_detail retourne stats.executions_total et affected_accounts_summary.total
-- Cette version remappe les champs pour compatibilité frontend.

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
  -- Appel de la RPC existante
  v_raw := public.get_playbook_full_detail(p_playbook_id);

  -- Si null (playbook non trouvé ou cross-tenant), retourner null
  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;

  -- Remapper pour compatibilité frontend :
  -- - Spread playbook fields au top level (flat)
  -- - stats → execution_stats (avec total = executions_total)
  -- - affected_accounts_summary → eligible_accounts
  -- - Ajouter current_eligible_count
  SELECT json_build_object(
    -- Flat playbook fields (frontend reads data.id, data.title, data.status)
    'id',                  v_raw->'playbook'->>'id',
    'title',               v_raw->'playbook'->>'title',
    'description',         v_raw->'playbook'->'description',
    'status',              v_raw->'playbook'->>'status',
    'priority',            v_raw->'playbook'->>'priority',
    'playbook_type',       v_raw->'playbook'->>'playbook_type',
    'template_category',   v_raw->'playbook'->'template_category',
    'is_automated',        (v_raw->'playbook'->>'is_automated')::boolean,
    'requires_approval',   (v_raw->'playbook'->>'requires_approval')::boolean,
    'is_template',         (v_raw->'playbook'->>'is_template')::boolean,
    'execution_frequency', v_raw->'playbook'->'execution_frequency',
    'last_executed_at',    v_raw->'playbook'->'last_executed_at',
    'created_at',          v_raw->'playbook'->>'created_at',
    'updated_at',          v_raw->'playbook'->>'updated_at',
    -- execution_stats with .total alias (frontend reads data.execution_stats.total)
    'execution_stats', json_build_object(
      'total',               (v_raw->'stats'->>'executions_total')::integer,
      'total_executions',    (v_raw->'stats'->>'executions_total')::integer,
      'completed',           (v_raw->'stats'->>'executions_completed')::integer,
      'failed',              (v_raw->'stats'->>'executions_failed')::integer,
      'in_progress',         (v_raw->'stats'->>'executions_in_progress')::integer,
      'targeted_count',      (v_raw->'stats'->>'targeted_count')::integer,
      'reached_count',       (v_raw->'stats'->>'reached_count')::integer,
      'converted_count',     (v_raw->'stats'->>'converted_count')::integer,
      'mrr_recovered_cents', (v_raw->'stats'->>'mrr_recovered_cents')::integer,
      'mrr_expansion_cents', (v_raw->'stats'->>'mrr_expansion_cents')::integer
    ),
    -- eligible_accounts summary (frontend reads data.eligible_accounts.total)
    'eligible_accounts', json_build_object(
      'total',             (v_raw->'affected_accounts_summary'->>'total')::integer,
      'mrr_at_risk_cents', (v_raw->'affected_accounts_summary'->>'mrr_at_risk_cents')::integer,
      'by_urgency',        v_raw->'affected_accounts_summary'->'by_urgency',
      'urgent_count',      (v_raw->'affected_accounts_summary'->'by_urgency'->>'urgent')::integer,
      'surveiller_count',  (v_raw->'affected_accounts_summary'->'by_urgency'->>'watch')::integer,
      'stable_count',      (v_raw->'affected_accounts_summary'->'by_urgency'->>'stable')::integer
    ),
    -- Also as affected_accounts_summary for backwards compat
    'affected_accounts_summary', v_raw->'affected_accounts_summary',
    -- Legacy scalar (frontend reads data.current_eligible_count)
    'current_eligible_count', (v_raw->'stats'->>'eligible_count')::integer,
    -- Raw conditions and actions
    'conditions',          v_raw->'conditions',
    'actions',             v_raw->'actions',
    -- Original stats for backwards compat
    'stats',               v_raw->'stats'
  )
  INTO v_result;

  RETURN v_result;
END;
$$;
