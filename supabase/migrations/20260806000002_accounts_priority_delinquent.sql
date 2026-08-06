-- Audit délinquence 2026-08-06, décision 3 (#7 de la recherche de
-- consommateurs "at risk") : accounts_with_priority.priority_label doit
-- refléter is_delinquent directement, en OR, pas via un seuil numérique —
-- sinon un compte délinquent peut lire "at risk" sur la tuile Overview et
-- un badge de priorité plus bas sur sa propre ligne dans la liste Accounts,
-- exactement l'incohérence que cet audit corrige. Nouvelle branche
-- `WHEN a.is_delinquent THEN 'critical'` évaluée juste après churned (D1
-- reste prioritaire — un compte parti n'est jamais "at risk"), avant les
-- branches churn_risk_band/health_score existantes.
--
-- `is_delinquent` est déjà exposée par cette vue (SELECT a.* — colonne déjà
-- présente sur accounts depuis 20260804000001, ré-exposée par la recréation
-- de vue du 20260805000001) : recréer la vue ici réexpanse `a.*` à la liste
-- de colonnes courante, aucune colonne nouvelle à lister explicitement.
-- Suit le même pattern DROP/CREATE + garde-fou de drift que
-- 20260805000001_accounts_with_priority_column_drift_fix.sql —
-- voir docs/RUNBOOK.md §"Deploying backend ahead of its matching frontend".

DROP VIEW IF EXISTS public.accounts_with_priority;

CREATE VIEW public.accounts_with_priority
WITH (security_invoker = true) AS
SELECT
  a.*,
  CASE
    WHEN a.churn_risk_band = 'churned' THEN 'churned'
    WHEN a.is_delinquent THEN 'critical'
    WHEN a.churn_risk_band = 'high' OR a.health_score <= 30 THEN 'critical'
    WHEN a.churn_risk_band = 'watch' OR a.health_score <= 55 THEN 'watch'
    WHEN a.created_at >= (now() - interval '90 days') AND a.churn_risk_band = 'low' THEN 'new'
    ELSE 'stable'
  END AS priority_label
FROM public.accounts a;

GRANT SELECT ON public.accounts_with_priority TO authenticated, service_role;

-- Garde-fou de drift (identique à 20260805000001) — voir ce fichier pour le
-- détail du raisonnement complet.
DO $$
DECLARE
  missing_columns text;
BEGIN
  SELECT string_agg(c.column_name, ', ')
  INTO missing_columns
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = 'accounts'
    AND c.column_name NOT IN (
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'accounts_with_priority'
    );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION 'accounts_with_priority is missing accounts column(s): %. Every column of accounts must appear in this view (SELECT a.* freezes at CREATE VIEW time — see docs/RUNBOOK.md).', missing_columns;
  END IF;
END $$;
