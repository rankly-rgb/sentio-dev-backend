-- Fast-follow annoncé le 2026-08-10 (20260810000001), jamais fait depuis : les 6 cron
-- jobs "déjà sains" (jobid 38, 39, 40, 41, 42, 96 -- sync-stripe-all-orgs,
-- calculate-scores-safety, generate-insights-daily, churn-alert-daily,
-- weekly-digest-monday, compute-peer-benchmarks-daily) portent encore le JWT
-- service_role EN CLAIR dans cron.job.command (les 4 jobs cassés de l'issue #38 ont été
-- migrés vers Vault le 2026-08-10 ; ces 6 ne l'avaient volontairement pas été, "minimiser
-- le risque sur du code qui marche", en attendant ce fast-follow).
--
-- Vérifié en direct avant d'écrire cette migration (2026-08-23) : c'est bien le MÊME
-- littéral JWT sur les 6 jobs (une seule valeur -- la clé service_role actuelle, jamais
-- tournée depuis son exposition à `anon` documentée dans 20260813000003, CHANGELOG_STABILITY
-- "Action Naima, bloquante"). Cette migration ne fait PAS la rotation elle-même (action
-- manuelle Dashboard Supabase, hors périmètre d'une migration SQL) -- elle retire
-- uniquement les 6 dernières occurrences en clair du secret, pour que la rotation devienne
-- un geste sûr (une seule valeur à mettre à jour dans Vault, plus aucune ligne cron.job à
-- réécrire manuellement au moment de tourner la clé).
--
-- `cron_dispatch_via_vault` existe déjà (20260810000001) et porte déjà la garde de rôle
-- posée par le Lot 1 (20260813000003, `request.jwt.claims ->> 'role' IS DISTINCT FROM
-- 'service_role'` -> exception). Cette migration élargit uniquement son allowlist
-- (jusqu'ici limitée aux 4 function_path de l'issue #38) aux 6 nouveaux -- sans quoi
-- l'appel lèverait "function_path % not in allowlist" pour chacun d'eux.
--
-- Rejouabilité : même garde jobid+jobname que 20260815... (commit 84003ba) -- ces 11 cron
-- jobs n'existent que sur ce projet (aucune migration ne les crée, cf. PARKING_LOT.md
-- "Cron jobs -- jamais versionnés"), donc `cron.alter_job` doit rester no-op plutôt
-- qu'échouer sur une base neuve / le shadow DB du drift-check.

CREATE OR REPLACE FUNCTION public.cron_dispatch_via_vault(function_path TEXT, timeout_ms INTEGER DEFAULT 25000)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $$
DECLARE
  svc_key TEXT;
BEGIN
  IF current_setting('request.jwt.claims', true) IS NOT NULL
     AND (current_setting('request.jwt.claims', true)::jsonb ->> 'role') IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION 'internal function: service_role only';
  END IF;

  IF function_path NOT IN (
    'refresh-hubspot-tokens', 'sync-hubspot', 'playbook-scheduler', 'self-monitor',
    'sync-stripe', 'calculate-scores', 'generate-insights', 'churn-alert',
    'weekly-digest', 'compute-peer-benchmarks'
  ) THEN
    RAISE EXCEPTION 'cron_dispatch_via_vault: function_path % not in allowlist', function_path;
  END IF;

  SELECT decrypted_secret INTO svc_key
  FROM vault.decrypted_secrets
  WHERE name = 'cron_service_role_key'
  LIMIT 1;

  IF svc_key IS NULL THEN
    RAISE NOTICE '[cron_dispatch_via_vault] Secret Vault cron_service_role_key absent -- % ignoré', function_path;
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/' || function_path,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || svc_key,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := timeout_ms
  );
END;
$$;

COMMENT ON FUNCTION public.cron_dispatch_via_vault(TEXT, INTEGER) IS
  'Dispatch cron -> Edge Function via net.http_post, auth lue depuis Supabase Vault (secret cron_service_role_key). Allowlist étendue le 2026-08-23 (fast-follow avant rotation service_role) aux 6 jobs "sains" qui portaient encore le JWT en clair.';

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = 38 AND jobname = 'sync-stripe-all-orgs') THEN
    PERFORM cron.alter_job(38, command := $cron$SELECT public.cron_dispatch_via_vault('sync-stripe', 25000)$cron$);
  ELSE
    RAISE NOTICE 'cron job 38 (%) absent — alter_job ignoré (base neuve ou jobid réattribué).', 'sync-stripe-all-orgs';
  END IF;
END
$guard$;
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = 39 AND jobname = 'calculate-scores-safety') THEN
    PERFORM cron.alter_job(39, command := $cron$SELECT public.cron_dispatch_via_vault('calculate-scores', 25000)$cron$);
  ELSE
    RAISE NOTICE 'cron job 39 (%) absent — alter_job ignoré (base neuve ou jobid réattribué).', 'calculate-scores-safety';
  END IF;
END
$guard$;
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = 40 AND jobname = 'generate-insights-daily') THEN
    PERFORM cron.alter_job(40, command := $cron$SELECT public.cron_dispatch_via_vault('generate-insights', 25000)$cron$);
  ELSE
    RAISE NOTICE 'cron job 40 (%) absent — alter_job ignoré (base neuve ou jobid réattribué).', 'generate-insights-daily';
  END IF;
END
$guard$;
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = 41 AND jobname = 'churn-alert-daily') THEN
    PERFORM cron.alter_job(41, command := $cron$SELECT public.cron_dispatch_via_vault('churn-alert', 25000)$cron$);
  ELSE
    RAISE NOTICE 'cron job 41 (%) absent — alter_job ignoré (base neuve ou jobid réattribué).', 'churn-alert-daily';
  END IF;
END
$guard$;
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = 42 AND jobname = 'weekly-digest-monday') THEN
    PERFORM cron.alter_job(42, command := $cron$SELECT public.cron_dispatch_via_vault('weekly-digest', 55000)$cron$);
  ELSE
    RAISE NOTICE 'cron job 42 (%) absent — alter_job ignoré (base neuve ou jobid réattribué).', 'weekly-digest-monday';
  END IF;
END
$guard$;
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = 96 AND jobname = 'compute-peer-benchmarks-daily') THEN
    PERFORM cron.alter_job(96, command := $cron$SELECT public.cron_dispatch_via_vault('compute-peer-benchmarks', 25000)$cron$);
  ELSE
    RAISE NOTICE 'cron job 96 (%) absent — alter_job ignoré (base neuve ou jobid réattribué).', 'compute-peer-benchmarks-daily';
  END IF;
END
$guard$;
