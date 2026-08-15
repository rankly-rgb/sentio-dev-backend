-- Fix : 4 cron jobs (refresh-hubspot-tokens, sync-hubspot-daily, playbook-scheduler,
-- self-monitor) ont échoué sur 100% de leurs runs depuis leur création (issue #38, GitHub
-- rankly-rgb/sentio-dev-backend). Confirmé en base sur le projet dev (2026-08-10) :
-- jobid 2 -> 0/779, jobid 6 -> 0/149, jobid 7 -> 0/14353, jobid 8 -> 0/14182, erreur
-- identique sur chaque run : `unrecognized configuration parameter
-- "app.supabase_functions_url"`. Ni cette GUC ni app.service_role_key n'ont jamais été
-- définies au niveau base -- le pattern current_setting() n'a jamais fonctionné, depuis
-- mars 2026.
--
-- Conséquence directe tant que ce fix n'est pas déployé : aucun playbook automatique
-- (cron) n'a jamais tourné, self-monitor (le filet de sécurité -- libération des locks
-- expirés, alertes Slack, auto-fail des exécutions bloquées) n'a jamais tourné, et
-- HubSpot n'a jamais été synchronisé ni ses tokens rafraîchis par le chemin cron.
--
-- Fix choisi : les 6 jobs déjà sains (38, 39, 40, 41, 42, 64, tous 100% succès) évitent
-- ce bug en codant l'URL et le JWT service_role en clair, directement dans
-- cron.job.command -- pattern qui marche, mais qui duplique un secret en clair dans une
-- ligne de DB à chaque nouveau job. Plutôt que d'ajouter une 5e/6e/7e/8e copie littérale
-- (et alors que la clé service_role actuelle est déjà un secret compromis en attente de
-- rotation -- committée en clair dans 20260531000001/3/5, cf. le commentaire de
-- 20260802000001_fix_trigger_hardcoded_key.sql), ce correctif suit exactement le même
-- pattern déjà adopté pour on_playbook_activate dans cette dernière migration : lecture
-- du secret depuis Supabase Vault au moment de l'appel. Bénéfice additionnel : le jour de
-- la rotation, une seule valeur à mettre à jour (le secret Vault) au lieu de N occurrences
-- littérales dispersées dans cron.job.
--
-- Action manuelle requise après le déploiement de cette migration (ne peut pas être
-- automatisée sans re-hardcoder un secret dans git) :
--   select vault.create_secret(
--     '<valeur actuelle de SUPABASE_SERVICE_ROLE_KEY>',
--     'cron_service_role_key',
--     'Service role key utilisée par les cron jobs pour authentifier leurs appels net.http_post vers les Edge Functions'
--   );
-- Tant que ce secret Vault n'existe pas, les 4 jobs ci-dessous no-op proprement
-- (RAISE NOTICE, RETURN) au lieu d'échouer bruyamment -- même dégradation que le trigger
-- de la migration précédente.
--
-- Portée : uniquement les 4 jobs cassés listés dans l'issue #38. Les 6 jobs déjà sains ne
-- sont pas touchés par cette migration (déjà fonctionnels, minimiser le risque sur du code
-- qui marche) -- ils restent une cible de suivi pour la même raison Vault avant la
-- rotation effective de la clé, à traiter séparément.
--
-- Rotation de la clé service_role elle-même : action distincte, hors scope de cette
-- migration, toujours en attente (Supabase Dashboard -> Project Settings -> API -> Roll
-- service_role key), cf. 20260802000001.

CREATE OR REPLACE FUNCTION public.cron_dispatch_via_vault(function_path TEXT, timeout_ms INTEGER DEFAULT 25000)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $$
DECLARE
  svc_key TEXT;
BEGIN
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
  'Dispatch cron -> Edge Function via net.http_post, auth lue depuis Supabase Vault (secret cron_service_role_key). Introduite pour fixer refresh-hubspot-tokens/sync-hubspot-daily/playbook-scheduler/self-monitor (issue #38) sans dupliquer davantage la clé service_role en clair dans cron.job.';

-- Rejouabilité (ajouté 2026-08-15) : ces quatre appels désignaient les jobs par
-- leur `jobid` numérique nu. Ces identifiants n'existent que sur le projet dev —
-- aucune migration ne crée de cron job, ils ont tous été créés à la main. Sur
-- toute base neuve (base shadow de `supabase db diff`, restauration, nouvel
-- environnement), `cron.alter_job(2, ...)` échouait donc avec « Job 2 does not
-- exist », interrompant le rejeu de l'historique complet des migrations — et
-- rendant `db diff --linked` inutilisable, donc la détection de dérive aveugle.
--
-- La garde ci-dessous ne change RIEN là où les jobs existent (le projet dev, où
-- cette migration est déjà appliquée depuis le 2026-08-10) : jobid ET jobname
-- doivent correspondre, ce qui est le cas. Ailleurs, elle rend l'appel no-op au
-- lieu d'échouer. Le `jobname` est vérifié en plus du `jobid` pour ne jamais
-- réécrire par accident un job différent qui aurait hérité du même numéro.
--
-- Le fond du problème — les cron jobs ne sont pas versionnés du tout — n'est pas
-- traité ici : voir PARKING_LOT.md.

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = 2 AND jobname = 'refresh-hubspot-tokens') THEN
    PERFORM cron.alter_job(2, command := $cron$SELECT public.cron_dispatch_via_vault('refresh-hubspot-tokens')$cron$);
  ELSE
    RAISE NOTICE 'cron job 2 (%) absent — alter_job ignoré (base neuve ou jobid réattribué).', 'refresh-hubspot-tokens';
  END IF;
END
$guard$;
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = 6 AND jobname = 'sync-hubspot-daily') THEN
    PERFORM cron.alter_job(6, command := $cron$SELECT public.cron_dispatch_via_vault('sync-hubspot')$cron$);
  ELSE
    RAISE NOTICE 'cron job 6 (%) absent — alter_job ignoré (base neuve ou jobid réattribué).', 'sync-hubspot-daily';
  END IF;
END
$guard$;
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = 7 AND jobname = 'playbook-scheduler') THEN
    PERFORM cron.alter_job(7, command := $cron$SELECT public.cron_dispatch_via_vault('playbook-scheduler')$cron$);
  ELSE
    RAISE NOTICE 'cron job 7 (%) absent — alter_job ignoré (base neuve ou jobid réattribué).', 'playbook-scheduler';
  END IF;
END
$guard$;
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = 8 AND jobname = 'self-monitor') THEN
    PERFORM cron.alter_job(8, command := $cron$SELECT public.cron_dispatch_via_vault('self-monitor')$cron$);
  ELSE
    RAISE NOTICE 'cron job 8 (%) absent — alter_job ignoré (base neuve ou jobid réattribué).', 'self-monitor';
  END IF;
END
$guard$;
