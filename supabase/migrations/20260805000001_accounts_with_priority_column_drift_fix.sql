-- Incident 2026-08-05 (IMPLEMENTATION_LOG.md, docs/RUNBOOK.md §"Deploying
-- backend ahead of its matching frontend") : accounts_with_priority est
-- définie `SELECT a.* ... FROM accounts a` — Postgres fige le `*` en liste
-- de colonnes explicite au moment de la création de la vue, une colonne
-- ajoutée après coup sur `accounts` n'apparaît PAS automatiquement dans la
-- vue. La dernière recréation de la vue (20260803000002) précède d'un jour
-- la migration ayant ajouté 7 colonnes du chantier MRR Engine v2
-- (20260804000001) : mrr_status, trial_mrr_cents, is_delinquent,
-- pending_cancellation, is_zero_dollar_active, billing_model, currency —
-- toutes absentes de la vue depuis, pas seulement mrr_status (dont l'absence
-- a cassé accounts-api en premier, PR #27 commit 8ac3223). Vérifié en base
-- via information_schema.columns avant ce correctif : ces 7 colonnes
-- manquent bien, aucune autre.
--
-- Recréer la vue avec le même SELECT a.* la réexpanse en liste de colonnes
-- à jour au moment de CETTE migration — elle regagne donc naturellement les
-- 7 colonnes manquantes, sans qu'il soit nécessaire de les lister une par
-- une. Logique CASE priority_label inchangée (identique à 20260803000002).

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

-- Garde-fou structurel (demandé explicitement, cet incident ne doit pas se
-- reproduire au prochain ADD COLUMN sur accounts) : vérifie à l'application
-- de CETTE migration que la vue expose bien toutes les colonnes actuelles
-- de accounts. Ne protège pas contre une future migration qui ajouterait
-- une colonne sans recréer la vue (impossible à détecter en SQL pur au
-- moment où cette migration s'applique, puisque la colonne future n'existe
-- pas encore) — c'est le rôle du contrôle CI post-déploiement ajouté dans
-- .github/workflows/supabase-deploy.yml, qui s'exécute après CHAQUE déploiement,
-- pas seulement à la création de cette vue.
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
