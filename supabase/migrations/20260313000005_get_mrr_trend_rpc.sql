-- ============================================================
-- RPC: get_mrr_trend
-- Retourne la serie temporelle MRR agregee par jour pour l'org.
-- Source : score_history (snapshot quotidien par compte).
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_mrr_trend(
  p_start_date DATE DEFAULT (CURRENT_DATE - INTERVAL '30 days')::DATE,
  p_end_date   DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  snapshot_date   DATE,
  total_mrr_cents BIGINT,
  account_count   BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
BEGIN
  v_org_id := public.user_organization_id();
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'User has no associated organization';
  END IF;

  -- Cap range to 365 days max
  IF p_end_date - p_start_date > 365 THEN
    p_start_date := p_end_date - 365;
  END IF;

  RETURN QUERY
  SELECT
    sh.snapshot_date,
    COALESCE(SUM(sh.mrr_cents), 0)::BIGINT AS total_mrr_cents,
    COUNT(DISTINCT sh.account_id)           AS account_count
  FROM score_history sh
  WHERE sh.organization_id = v_org_id
    AND sh.snapshot_date >= p_start_date
    AND sh.snapshot_date <= p_end_date
  GROUP BY sh.snapshot_date
  ORDER BY sh.snapshot_date ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_mrr_trend(DATE, DATE) TO authenticated;


-- ============================================================
-- RPC: get_mrr_movements_summary
-- Ventilation des mouvements MRR (new, expansion, contraction,
-- churn, reactivation) agreges par jour.
-- Source : mrr_movements (evenementiel).
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_mrr_movements_summary(
  p_start_date DATE DEFAULT (CURRENT_DATE - INTERVAL '30 days')::DATE,
  p_end_date   DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  movement_date       DATE,
  new_mrr_cents       BIGINT,
  expansion_mrr_cents BIGINT,
  contraction_mrr_cents BIGINT,
  churn_mrr_cents     BIGINT,
  reactivation_mrr_cents BIGINT,
  net_mrr_cents       BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
BEGIN
  v_org_id := public.user_organization_id();
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'User has no associated organization';
  END IF;

  -- Cap range to 365 days max
  IF p_end_date - p_start_date > 365 THEN
    p_start_date := p_end_date - 365;
  END IF;

  RETURN QUERY
  SELECT
    m.movement_date,
    COALESCE(SUM(CASE WHEN m.movement_type = 'new'          THEN m.amount_cents END), 0)::BIGINT AS new_mrr_cents,
    COALESCE(SUM(CASE WHEN m.movement_type = 'expansion'    THEN m.amount_cents END), 0)::BIGINT AS expansion_mrr_cents,
    COALESCE(SUM(CASE WHEN m.movement_type = 'contraction'  THEN m.amount_cents END), 0)::BIGINT AS contraction_mrr_cents,
    COALESCE(SUM(CASE WHEN m.movement_type = 'churn'        THEN m.amount_cents END), 0)::BIGINT AS churn_mrr_cents,
    COALESCE(SUM(CASE WHEN m.movement_type = 'reactivation' THEN m.amount_cents END), 0)::BIGINT AS reactivation_mrr_cents,
    COALESCE(SUM(
      CASE
        WHEN m.movement_type IN ('new', 'expansion', 'reactivation') THEN m.amount_cents
        WHEN m.movement_type IN ('contraction', 'churn')             THEN -m.amount_cents
        ELSE 0
      END
    ), 0)::BIGINT AS net_mrr_cents
  FROM mrr_movements m
  WHERE m.organization_id = v_org_id
    AND m.movement_date >= p_start_date
    AND m.movement_date <= p_end_date
  GROUP BY m.movement_date
  ORDER BY m.movement_date ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_mrr_movements_summary(DATE, DATE) TO authenticated;
