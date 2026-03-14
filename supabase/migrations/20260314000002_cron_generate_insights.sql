-- ============================================================
-- Migration : Cron jobs pour le pipeline de données complet
--
-- generate-insights n'avait aucun cron configuré, ce qui faisait
-- que les nouvelles organisations (ex: Test OAuth Corp) n'avaient
-- jamais d'insights générés automatiquement.
--
-- Ce cron couvre TOUTES les organisations actives à chaque run
-- (pas d'organization_id dans le body → boucle sur toutes les orgs).
--
-- Pipeline quotidien :
--   1. sync-stripe (02h00 UTC) — sync données Stripe
--   2. sync-hubspot (02h30 UTC) — sync données HubSpot
--   3. calculate-scores (03h00 UTC) — scoring + segmentation
--   4. generate-insights (04h00 UTC) — génération insights IA
--
-- Prérequis : pg_cron + pg_net activés (fait dans migration 20260308000003)
-- ============================================================

-- generate-insights : quotidien à 04h00 UTC (après calculate-scores à 03h00)
-- Traite TOUTES les orgs actives (body vide = boucle complète)
SELECT cron.schedule(
  'generate-insights-daily',
  '0 4 * * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_functions_url') || '/generate-insights',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )$$
);

-- calculate-scores : quotidien à 03h00 UTC (après sync-stripe/hubspot)
-- Idempotent via cron_lock interne
SELECT cron.schedule(
  'calculate-scores-daily',
  '0 3 * * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_functions_url') || '/calculate-scores',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )$$
);

-- sync-stripe : quotidien à 02h00 UTC
-- Idempotent via cron_lock interne
SELECT cron.schedule(
  'sync-stripe-daily',
  '0 2 * * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_functions_url') || '/sync-stripe',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )$$
);

-- sync-hubspot : quotidien à 02h30 UTC
-- Idempotent via cron_lock interne
SELECT cron.schedule(
  'sync-hubspot-daily',
  '30 2 * * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_functions_url') || '/sync-hubspot',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )$$
);

-- playbook-scheduler : toutes les 15 minutes (exécution playbooks automatisés)
SELECT cron.schedule(
  'playbook-scheduler',
  '*/15 * * * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_functions_url') || '/playbook-scheduler',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )$$
);

-- self-monitor : toutes les 15 minutes (health checks + auto-recovery)
SELECT cron.schedule(
  'self-monitor',
  '*/15 * * * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_functions_url') || '/self-monitor',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )$$
);
