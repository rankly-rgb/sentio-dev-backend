-- ============================================================
-- Prérequis pour les cron jobs d'alertes email
--
-- Les extensions pg_cron et pg_net sont déjà activées
-- (migration 20260517000002_setup_cron_jobs.sql).
--
-- Les jobs réels sont configurés dans docs/setup/cron_jobs_setup.sql
-- (ajouter les deux jobs churn-alert et weekly-digest à la liste).
-- ============================================================

-- Extensions déjà présentes — aucune action requise.
-- Cette migration sert de marqueur pour la feature email-alerts v1.
SELECT 1;
