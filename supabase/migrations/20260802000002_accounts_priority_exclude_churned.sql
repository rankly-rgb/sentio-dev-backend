-- D1/C2.2 (2026-08-02) : accounts_with_priority (posée par
-- 20260705000002_accounts_priority_label_view.sql, basculée sur
-- churn_risk_band par 20260725000002_accounts_priority_churn_band.sql)
-- pouvait encore classer un compte churné en 'critical'/'watch' via la
-- branche de repli `health_score <= 30/55` : churn_risk_band='churned'
-- n'empêchait pas health_score (dimension indépendante, jamais gelée par
-- D1) d'être bas pour un compte qui vient de churner (ex. factures
-- impayées historiques faisant chuter payment_health_score). Un compte
-- parti n'est pas "à risque", il est perdu — la branche churned doit être
-- évaluée en premier, avant toute retombée sur health_score.
--
-- Même contrainte de DROP + CREATE que 20260725000002 (repositionnement de
-- colonne interdit par Postgres sur un simple CREATE OR REPLACE) — voir le
-- commentaire de cette migration pour le détail.

DROP VIEW IF EXISTS public.accounts_with_priority;

CREATE VIEW public.accounts_with_priority
WITH (security_invoker = true) AS
SELECT
  a.*,
  CASE
    WHEN a.churn_risk_band = 'churned' THEN 'churned'
    WHEN a.churn_risk_band = 'high' OR a.health_score <= 30 THEN 'critical'
    WHEN a.churn_risk_band = 'watch' OR a.health_score <= 55 THEN 'watch'
    WHEN a.created_at >= (now() - interval '90 days') AND a.churn_risk_band = 'low' THEN 'new'
    ELSE 'stable'
  END AS priority_label
FROM public.accounts a;

GRANT SELECT ON public.accounts_with_priority TO authenticated, service_role;
