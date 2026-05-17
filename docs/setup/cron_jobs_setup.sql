-- ============================================================
-- Sentio AI — Configuration des cron jobs automatiques
--
-- À exécuter UNE SEULE FOIS dans le SQL Editor Supabase.
-- Remplacer les deux placeholders avant d'exécuter.
--
-- Supabase Dashboard → SQL Editor → New Query → coller + Run
-- ============================================================

-- ── 1. Remplacer ces deux valeurs ────────────────────────────
-- SUPABASE_URL       : Settings → API → Project URL
--                      ex: https://abcdefgh.supabase.co
-- SERVICE_ROLE_KEY   : Settings → API → service_role (secret)
--                      ex: eyJhbGci...

DO $$
DECLARE
  v_url  text := 'https://YOUR_PROJECT_REF.supabase.co';   -- ← REMPLACER
  v_key  text := 'YOUR_SERVICE_ROLE_KEY';                   -- ← REMPLACER
BEGIN

  -- ── Supprimer les anciens jobs si existants ────────────────
  PERFORM cron.unschedule('sync-stripe-all-orgs')    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-stripe-all-orgs');
  PERFORM cron.unschedule('calculate-scores-safety') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'calculate-scores-safety');
  PERFORM cron.unschedule('generate-insights-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'generate-insights-daily');

  -- ── Job 1 : sync-stripe toutes les orgs — 02:00 UTC ───────
  -- Appelle sync-stripe sans organization_id → boucle sur toutes les orgs actives
  PERFORM cron.schedule(
    'sync-stripe-all-orgs',
    '0 2 * * *',
    format(
      $$
      SELECT net.http_post(
        url     := %L,
        headers := %L::jsonb,
        body    := '{}'::jsonb
      )
      $$,
      v_url || '/functions/v1/sync-stripe',
      jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key)::text
    )
  );

  -- ── Job 2 : calculate-scores toutes les orgs — 03:00 UTC ──
  -- Filet de sécurité : re-score même si sync-stripe n'a pas déclenché le scoring
  PERFORM cron.schedule(
    'calculate-scores-safety',
    '0 3 * * *',
    format(
      $$
      SELECT net.http_post(
        url     := %L,
        headers := %L::jsonb,
        body    := '{}'::jsonb
      )
      $$,
      v_url || '/functions/v1/calculate-scores',
      jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key)::text
    )
  );

  -- ── Job 3 : generate-insights — 04:00 UTC ─────────────────
  PERFORM cron.schedule(
    'generate-insights-daily',
    '0 4 * * *',
    format(
      $$
      SELECT net.http_post(
        url     := %L,
        headers := %L::jsonb,
        body    := '{}'::jsonb
      )
      $$,
      v_url || '/functions/v1/generate-insights',
      jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key)::text
    )
  );

  RAISE NOTICE 'Cron jobs créés : sync-stripe-all-orgs (02:00), calculate-scores-safety (03:00), generate-insights-daily (04:00)';
END;
$$;

-- ── Vérification ──────────────────────────────────────────────
SELECT jobname, schedule, command, active
FROM cron.job
WHERE jobname IN ('sync-stripe-all-orgs', 'calculate-scores-safety', 'generate-insights-daily');
