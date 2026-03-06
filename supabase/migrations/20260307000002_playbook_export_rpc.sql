-- Migration: get_playbook_export_summary RPC
-- Returns export preview summary without triggering the actual export.
-- Called by frontend to display confirmation dialog.

CREATE OR REPLACE FUNCTION public.get_playbook_export_summary(
  p_playbook_id UUID,
  p_filters JSONB DEFAULT '{}'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
  v_playbook_org_id UUID;
  v_result JSON;
BEGIN
  -- Resolve caller's organization_id (RLS enforcement)
  v_org_id := public.user_organization_id();
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no organization context';
  END IF;

  -- Verify playbook belongs to caller's org
  SELECT organization_id INTO v_playbook_org_id
  FROM public.playbooks
  WHERE id = p_playbook_id;

  IF v_playbook_org_id IS NULL THEN
    RAISE EXCEPTION 'Playbook not found';
  END IF;

  IF v_playbook_org_id <> v_org_id THEN
    RAISE EXCEPTION 'Forbidden: cross-tenant access';
  END IF;

  -- Build summary
  WITH filtered_accounts AS (
    SELECT
      a.id,
      a.mrr_cents,
      a.churn_risk_score,
      a.health_score,
      a.contract_end_date,
      a.billing_interval,
      -- Priority calculation (same logic as Edge Function)
      CASE
        WHEN a.churn_risk_score >= 70
             AND a.contract_end_date IS NOT NULL
             AND (a.contract_end_date - CURRENT_DATE) < 30
          THEN 'P0'
        WHEN a.churn_risk_score >= 50
             OR (a.contract_end_date IS NOT NULL AND (a.contract_end_date - CURRENT_DATE) < 60)
          THEN 'P1'
        ELSE 'P2'
      END AS priority,
      -- Segment name via active membership
      cs.segment_type
    FROM public.accounts a
    LEFT JOIN public.segment_memberships sm
      ON sm.account_id = a.id
      AND sm.organization_id = v_org_id
      AND sm.status = 'active'
    LEFT JOIN public.account_segments cs
      ON cs.id = sm.segment_id
      AND cs.organization_id = v_org_id
    WHERE a.organization_id = v_org_id
      -- Apply optional filters
      AND (
        NOT (p_filters ? 'churn_risk_min')
        OR a.churn_risk_score >= (p_filters->>'churn_risk_min')::NUMERIC
      )
      AND (
        NOT (p_filters ? 'mrr_min_cents')
        OR a.mrr_cents >= (p_filters->>'mrr_min_cents')::INTEGER
      )
      AND (
        NOT (p_filters ? 'billing_interval')
        OR a.billing_interval = (p_filters->>'billing_interval')
      )
      AND (
        NOT (p_filters ? 'segment')
        OR cs.segment_type = (p_filters->>'segment')
      )
  )
  SELECT json_build_object(
    'total_accounts', COUNT(*),
    'total_mrr_at_risk_cents', COALESCE(SUM(
      CASE WHEN priority IN ('P0', 'P1') THEN mrr_cents ELSE 0 END
    ), 0),
    'by_priority', json_build_object(
      'P0', COUNT(*) FILTER (WHERE priority = 'P0'),
      'P1', COUNT(*) FILTER (WHERE priority = 'P1'),
      'P2', COUNT(*) FILTER (WHERE priority = 'P2')
    ),
    'by_segment', COALESCE(
      (SELECT json_object_agg(seg, cnt)
       FROM (
         SELECT COALESCE(segment_type, 'Non segmente') AS seg, COUNT(*) AS cnt
         FROM filtered_accounts
         GROUP BY segment_type
       ) sub),
      '{}'::JSON
    )
  ) INTO v_result
  FROM filtered_accounts;

  RETURN v_result;
END;
$$;

-- Grant execute to authenticated users (RLS enforced inside function)
GRANT EXECUTE ON FUNCTION public.get_playbook_export_summary(UUID, JSONB) TO authenticated;
