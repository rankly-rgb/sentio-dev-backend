-- Action 4 (5.3+5.4+5.5) : versioning de score_history + indicateur de
-- complétude des données.
--
-- Le nouveau comportement de calcFinancialScore (distinguer "jamais eu de
-- subscription" de "vrai churn", voir _shared/scoring.ts) doit être
-- traçable dans l'historique — sans model_version, un changement de valeur
-- causé par la nouvelle logique serait indiscernable d'un vrai changement
-- business. signals_available/data_completeness_pct alimentent le futur
-- badge "Calculé sur X/4 signaux" (câblage UI reporté à la phase frontend).
--
-- Toutes nullable : les lignes historiques précèdent ce versioning, pas de
-- backfill. Convention data_completeness_pct (NUMERIC(5,2) + CHECK 0-100)
-- alignée sur cohorts/retention_metrics (20260301000004_phase3_analytics.sql).

ALTER TABLE public.score_history
  ADD COLUMN IF NOT EXISTS model_version TEXT,
  ADD COLUMN IF NOT EXISTS inputs_used JSONB,
  ADD COLUMN IF NOT EXISTS inputs_missing JSONB,
  ADD COLUMN IF NOT EXISTS signals_available JSONB,
  ADD COLUMN IF NOT EXISTS data_completeness_pct NUMERIC(5,2);

ALTER TABLE public.score_history
  DROP CONSTRAINT IF EXISTS score_history_data_completeness_check;

ALTER TABLE public.score_history
  ADD CONSTRAINT score_history_data_completeness_check CHECK (
    data_completeness_pct BETWEEN 0 AND 100 OR data_completeness_pct IS NULL
  );
