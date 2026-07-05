-- ============================================================
-- Vue accounts_with_priority : ajoute priority_label calculé
-- ============================================================
--
-- priority_label (priorité décroissante, mutuellement exclusif) :
--   1. 'critique'     : churn_risk_score >= 80 OU health_score <= 30
--   2. 'surveillance' : churn_risk_score >= 50 OU health_score <= 55
--   3. 'nouveau'      : created_at dans les 90 derniers jours ET churn_risk_score < 50
--   4. 'stable'       : tous les autres cas
--
-- security_invoker = true : la vue s'exécute avec les permissions de
-- l'appelant (pas du propriétaire), donc la RLS de accounts s'applique
-- normalement pour toute requête passant par cette vue.

CREATE OR REPLACE VIEW public.accounts_with_priority
WITH (security_invoker = true) AS
SELECT
  a.*,
  CASE
    WHEN a.churn_risk_score >= 80 OR a.health_score <= 30 THEN 'critique'
    WHEN a.churn_risk_score >= 50 OR a.health_score <= 55 THEN 'surveillance'
    WHEN a.created_at >= (now() - interval '90 days') AND a.churn_risk_score < 50 THEN 'nouveau'
    ELSE 'stable'
  END AS priority_label
FROM public.accounts a;

GRANT SELECT ON public.accounts_with_priority TO authenticated, service_role;
