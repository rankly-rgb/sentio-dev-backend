-- Audit délinquence 2026-08-06, décision 3 : is_delinquent est un état
-- actionnable, pas seulement un signal de risque — il doit apparaître dans
-- les surfaces d'action en condition OR directe, jamais via un seuil
-- numérique conçu pour autre chose (churn_risk_score > 70 ne serait jamais
-- franchi par un compte uniquement délinquent, poids 35).
--
-- get_portfolio_snapshot.at_risk_count (20260712000001) alimente
-- get-today-status (seul consommateur — voir commentaire dans cette
-- fonction) : ratio "at_risk_count / scored_accounts_count > 30%" qui
-- détermine le statut portefeuille 'at_risk'. Élargi à
-- `churn_risk_score > 70 OR is_delinquent` pour qu'un compte délinquent
-- pèse dans ce ratio même s'il ne franchit jamais 70 seul.
--
-- scored_accounts_count reste inchangé (churn_risk_score IS NOT NULL) — un
-- compte délinquent traverse le scoring normal (D-NEXT, pas de court-
-- circuit), il a donc déjà un churn_risk_score non-null et est déjà compté
-- au dénominateur ; seul le numérateur (FILTER) change.

CREATE OR REPLACE FUNCTION public.get_portfolio_snapshot(p_organization_id UUID)
RETURNS TABLE (
  total_accounts BIGINT,
  total_mrr_cents BIGINT,
  avg_health_score NUMERIC,
  champions_count BIGINT,
  at_risk_count BIGINT,
  scored_accounts_count BIGINT
)
LANGUAGE SQL
STABLE
AS $$
  SELECT
    COUNT(*) AS total_accounts,
    COALESCE(SUM(a.mrr_cents), 0) AS total_mrr_cents,
    ROUND(AVG(a.health_score), 1) AS avg_health_score,
    (
      SELECT COUNT(*)
      FROM public.segment_memberships sm
      JOIN public.account_segments seg ON seg.id = sm.segment_id
      WHERE seg.organization_id = p_organization_id
        AND seg.segment_type = 'champions'
        AND sm.status = 'active'
    ) AS champions_count,
    COUNT(*) FILTER (WHERE a.churn_risk_score > 70 OR a.is_delinquent) AS at_risk_count,
    COUNT(*) FILTER (WHERE a.churn_risk_score IS NOT NULL) AS scored_accounts_count
  FROM public.accounts a
  WHERE a.organization_id = p_organization_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_portfolio_snapshot(UUID) TO authenticated, service_role;
