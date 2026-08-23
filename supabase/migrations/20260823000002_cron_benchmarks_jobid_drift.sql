-- Suite immédiate de 20260823000001 : ce jour-là, `compute-peer-benchmarks-daily`
-- a été observé sous jobid 96 lors de l'investigation (vérifié en direct via
-- execute_sql avant d'écrire cette migration-là), mais au moment où `db push`
-- l'a réellement appliquée quelques minutes plus tard, le job vivait déjà sous
-- jobid 97 (même jobname, même schedule '0 2 * * *') -- confirmé en direct
-- post-déploiement : jobid 96 n'existe plus du tout, jobid 97 porte toujours le
-- JWT service_role en clair. La garde `IF EXISTS (jobid = 96 AND jobname = ...)`
-- de 20260823000001 a donc silencieusement no-opé sur CE job précis (les 5
-- autres, jobid 38/39/40/41/42, n'ont pas bougé et ont bien été migrés).
--
-- Cause du drift non élucidée (aucun changement de ce chantier ne touche
-- cron.job autrement qu'en ALTER sur les jobid déjà vérifiés) -- cohérent avec
-- le constat déjà documenté ailleurs (PARKING_LOT.md, "Cron jobs -- jamais
-- versionnés") : ces jobs n'existent que parce qu'ils ont été créés à la main,
-- rien n'empêche un jobid de changer si le job est un jour redéclaré (drop +
-- recreate) hors migration. Signal, pas un correctif de la cause -- capturé
-- tel quel plutôt que retardé.

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = 97 AND jobname = 'compute-peer-benchmarks-daily') THEN
    PERFORM cron.alter_job(97, command := $cron$SELECT public.cron_dispatch_via_vault('compute-peer-benchmarks', 25000)$cron$);
  ELSE
    RAISE NOTICE 'cron job 97 (%) absent — alter_job ignoré (base neuve, jobid réattribué de nouveau, ou déjà migré).', 'compute-peer-benchmarks-daily';
  END IF;
END
$guard$;
