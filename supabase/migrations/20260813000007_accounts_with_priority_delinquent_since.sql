-- Lot V (2026-08-13) — correctif immédiat trouvé pendant la vérification
-- rétroactive : Lot 5 (#35, delinquent_since + churn_risk_band='critical')
-- a ajouté accounts.delinquent_since sans recréer accounts_with_priority.
-- `SELECT a.*` fige la liste de colonnes au moment du CREATE VIEW — la
-- garde de drift CI ("Verify accounts_with_priority has no column drift",
-- supabase-deploy.yml) l'a détecté au premier déploiement tenté après ce
-- lot : delinquent_since manquante, exactement le mécanisme que cette
-- garde existe pour attraper. accounts-api/index.ts sélectionne déjà
-- delinquent_since depuis cette vue (Lot 5) — sans ce correctif, ce
-- SELECT aurait échoué au premier déploiement réel des Edge Functions.
--
-- Même pattern DROP/CREATE + garde-fou de drift que 20260805000001 /
-- 20260806000002 — voir docs/RUNBOOK.md.
--
-- Profite du passage pour élargir la branche 'critical' du CASE
-- (churn_risk_band = 'high' OR 'critical', Lot 5) : is_delinquent est
-- évalué juste avant et intercepte déjà tout compte 'critical' par
-- construction (le plancher ne s'applique qu'aux comptes délinquents),
-- donc sans effet observable aujourd'hui — ajouté par défensivité (S1),
-- même raisonnement que determineSegmentTypesV3 (_shared/scoring.ts).

DROP VIEW IF EXISTS public.accounts_with_priority;

CREATE VIEW public.accounts_with_priority
WITH (security_invoker = true) AS
SELECT
  a.*,
  CASE
    WHEN a.churn_risk_band = 'churned' THEN 'churned'
    WHEN a.is_delinquent THEN 'critical'
    WHEN a.churn_risk_band = 'high' OR a.churn_risk_band = 'critical' OR a.health_score <= 30 THEN 'critical'
    WHEN a.churn_risk_band = 'watch' OR a.health_score <= 55 THEN 'watch'
    WHEN a.created_at >= (now() - interval '90 days') AND a.churn_risk_band = 'low' THEN 'new'
    ELSE 'stable'
  END AS priority_label
FROM public.accounts a;

GRANT SELECT ON public.accounts_with_priority TO authenticated, service_role;

-- Garde-fou de drift (identique à 20260805000001 / 20260806000002).
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
