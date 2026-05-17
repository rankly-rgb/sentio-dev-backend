-- ============================================================
-- Setup cron jobs via pg_cron + pg_net
--
-- IMPORTANT : cette migration crée uniquement la structure.
-- Les jobs pg_cron nécessitent l'URL et la clé service_role
-- qui ne doivent PAS être stockées dans le code source.
--
-- Après avoir appliqué cette migration, exécuter le script
-- docs/setup/cron_jobs_setup.sql dans le SQL Editor Supabase
-- en remplaçant les placeholders par vos valeurs réelles.
--
-- Supabase Dashboard → SQL Editor → coller cron_jobs_setup.sql
-- ============================================================

-- Extensions requises (activées par défaut sur Supabase)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
