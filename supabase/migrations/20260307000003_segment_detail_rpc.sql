-- ============================================================
-- RPC: get_segment_accounts
-- Retourne les comptes d'un segment avec pagination et tri.
-- Utilise segment_memberships (source de verite) au lieu de
-- re-implementer les criteres de segmentation inline.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_segment_accounts(
  p_segment TEXT,
  p_sort_by TEXT DEFAULT 'mrr_cents',
  p_sort_order TEXT DEFAULT 'desc',
  p_limit INTEGER DEFAULT 100,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  stripe_customer_id TEXT,
  hubspot_company_id TEXT,
  plan_tier TEXT,
  billing_interval TEXT,
  mrr_cents INTEGER,
  seat_count INTEGER,
  seat_limit INTEGER,
  contract_end_date DATE,
  health_score NUMERIC,
  churn_risk_score NUMERIC,
  expansion_score NUMERIC,
  product_usage_score NUMERIC,
  total_count BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
BEGIN
  -- Resolve caller's organization
  v_org_id := public.user_organization_id();
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'User has no associated organization';
  END IF;

  -- Validate segment parameter
  IF p_segment NOT IN (
    'champions', 'en_expansion', 'stables', 'a_risque_leger',
    'en_danger_critique', 'impayes', 'en_churn', 'nouveaux'
  ) THEN
    RAISE EXCEPTION 'Invalid segment: %', p_segment;
  END IF;

  -- Validate sort_by parameter
  IF p_sort_by NOT IN ('mrr_cents', 'health_score', 'churn_risk_score', 'expansion_score') THEN
    p_sort_by := 'mrr_cents';
  END IF;

  -- Validate sort_order parameter
  IF p_sort_order NOT IN ('asc', 'desc') THEN
    p_sort_order := 'desc';
  END IF;

  -- Cap limit to prevent abuse
  IF p_limit > 10000 THEN
    p_limit := 10000;
  END IF;

  RETURN QUERY
  WITH filtered AS (
    SELECT a.*
    FROM accounts a
    INNER JOIN segment_memberships sm ON sm.account_id = a.id
    INNER JOIN account_segments seg ON seg.id = sm.segment_id
    WHERE a.organization_id = v_org_id
      AND seg.organization_id = v_org_id
      AND sm.organization_id = v_org_id
      AND seg.segment_type = p_segment
      AND sm.status = 'active'
      AND seg.is_active = TRUE
  )
  SELECT
    f.id,
    f.stripe_customer_id,
    f.hubspot_company_id,
    f.plan_tier,
    f.billing_interval,
    f.mrr_cents,
    f.seat_count,
    f.seat_limit,
    f.contract_end_date,
    f.health_score,
    f.churn_risk_score,
    f.expansion_score,
    f.product_usage_score,
    COUNT(*) OVER() AS total_count
  FROM filtered f
  ORDER BY
    CASE WHEN p_sort_order = 'desc' THEN
      CASE p_sort_by
        WHEN 'mrr_cents'        THEN f.mrr_cents
        WHEN 'health_score'     THEN f.health_score::INTEGER
        WHEN 'churn_risk_score' THEN f.churn_risk_score::INTEGER
        WHEN 'expansion_score'  THEN f.expansion_score::INTEGER
        ELSE f.mrr_cents
      END
    END DESC NULLS LAST,
    CASE WHEN p_sort_order = 'asc' THEN
      CASE p_sort_by
        WHEN 'mrr_cents'        THEN f.mrr_cents
        WHEN 'health_score'     THEN f.health_score::INTEGER
        WHEN 'churn_risk_score' THEN f.churn_risk_score::INTEGER
        WHEN 'expansion_score'  THEN f.expansion_score::INTEGER
        ELSE f.mrr_cents
      END
    END ASC NULLS LAST
  LIMIT p_limit OFFSET p_offset;
END;
$$;

-- Grant access to authenticated users (RLS enforced inside function via user_organization_id())
GRANT EXECUTE ON FUNCTION public.get_segment_accounts(TEXT, TEXT, TEXT, INTEGER, INTEGER) TO authenticated;
