-- ============================================================
-- accounts_with_priority — recréation pour absorber mrr_unavailable_reason
-- (2026-08-20, mission réconciliation Stripe, point 2)
--
-- Même incident structurel que 20260805000001 (docs/RUNBOOK.md §"Deploying
-- backend ahead of its matching frontend") : `accounts_with_priority` est
-- définie `SELECT a.* ...` — Postgres fige le `*` en liste de colonnes
-- explicite au moment du CREATE VIEW, une colonne ajoutée après coup sur
-- `accounts` (ici `mrr_unavailable_reason`, 20260820000001, quelques
-- secondes plus tôt dans cette même série) n'apparaît PAS automatiquement.
-- Recréer la vue avec le même SELECT a.* la réexpanse en liste de colonnes
-- à jour au moment de CETTE migration — logique CASE priority_label
-- inchangée (identique à 20260805000001).
-- ============================================================

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

-- Même garde-fou structurel que 20260805000001 — vérifie à l'application de
-- CETTE migration que la vue expose bien toutes les colonnes actuelles de
-- accounts.
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
