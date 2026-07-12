-- Chantier 5.1 : couche d'agrégation partagée.
-- get-today-status, accounts-api et dashboard-api recalculaient chacun
-- indépendamment (JS, sur des fetchs plafonnés à 500/2000/5000 lignes selon
-- le fichier) des totaux censés représenter la même réalité portefeuille.
-- Cette fonction devient la source unique pour total_accounts, total_mrr_cents,
-- avg_health_score, champions_count, at_risk_count et scored_accounts_count.
--
-- Convention suivie (cf. list_deduplicated_insights, 20260705000001) :
-- LANGUAGE SQL STABLE, p_organization_id explicite en paramètre, pas de
-- SECURITY DEFINER — le scoping se fait par paramètre, pas par RLS, car les
-- Edge Functions appellent via service_role (qui bypass RLS).
--
-- Seuil at_risk_count : churn_risk_score > 70 (strictement), pour préserver
-- exactement le comportement existant de get-today-status/index.ts
-- (AT_RISK_CHURN_THRESHOLD=70, comparaison stricte `>`). Note : ceci diffère
-- du seuil documenté du segment en_danger_critique dans CLAUDE.md
-- (churn_risk_score >= 70, inclusif) — divergence préexistante entre les deux
-- mécanismes, non corrigée ici pour ne pas changer un comportement de scoring
-- sans instruction explicite (cf. CLAUDE.md, contraintes Claude Code).

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
    COUNT(*) FILTER (WHERE a.churn_risk_score > 70) AS at_risk_count,
    COUNT(*) FILTER (WHERE a.churn_risk_score IS NOT NULL) AS scored_accounts_count
  FROM public.accounts a
  WHERE a.organization_id = p_organization_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_portfolio_snapshot(UUID) TO authenticated, service_role;
