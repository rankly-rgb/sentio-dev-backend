-- ============================================================
-- data_syncs.error_type : ajout de 'write_error'
--
-- BUG CORRIGÉ (audit sync 2026-08-15)
-- ──────────────────────────────────────────────────────────
-- `_shared/data-sync-logger.ts::complete()` écrit `error_type = 'write_error'`
-- depuis le 2026-08-04 (commit 4fa4fc0) pour marquer un run dégradé
-- (`completed_with_errors` / `failed` sur écritures partielles). Cette valeur
-- n'a jamais figuré dans la CHECK constraint, posée par
-- `20260301000006_phase5_data_syncs.sql` puis élargie à 'timeout' par
-- `20260304000001_stability_phase2_fixes.sql`.
--
-- Conséquence observée en production (log `sync-stripe`, 2026-08-15T07:10:52) :
--
--   [DataSyncLogger] complete() UPDATE failed: new row for relation
--   "data_syncs" violates check constraint "data_syncs_error_type_check" 23514
--   {"records_processed":367,"records_failed":189,...}
--
-- Tout sync avec `records_failed > 0` voyait donc son UPDATE de complétion
-- rejeté en bloc. La ligne restait `sync_status='running'` indéfiniment, et
-- `self-monitor` la marquait 15 minutes plus tard « exceeded 15 min running
-- time » — un diagnostic faux, qui décrit un blocage là où le sync avait en
-- réalité terminé son travail en 27 secondes.
--
-- Mesure avant correctif, sur 1938 lignes `data_syncs` depuis mars 2026 :
-- ZÉRO ligne `sync_status='completed_with_errors'`, ZÉRO ligne
-- `error_type='write_error'`. Le mécanisme construit pour rendre visibles les
-- échecs d'écriture silencieux n'avait jamais réussi à écrire une seule ligne
-- — il échouait lui-même silencieusement, exactement la classe de bug qu'il
-- devait éliminer.
--
-- Choix : élargir la contrainte plutôt que replier `write_error` sur une
-- valeur existante. 'write_error' est sémantiquement distinct des six autres
-- (qui décrivent tous un échec d'appel à une API externe) — c'est un échec
-- d'écriture côté base, sur des données pourtant correctement récupérées.
-- Le replier sur 'validation_error' ou 'api_error' rendrait ces runs
-- indiscernables d'une panne Stripe/HubSpot.
-- ============================================================

ALTER TABLE public.data_syncs
  DROP CONSTRAINT IF EXISTS data_syncs_error_type_check;

ALTER TABLE public.data_syncs
  ADD CONSTRAINT data_syncs_error_type_check CHECK (
    error_type = ANY (ARRAY[
      'api_error',
      'network_error',
      'validation_error',
      'rate_limit',
      'auth_error',
      'timeout',
      'write_error'
    ])
    OR error_type IS NULL
  );

COMMENT ON COLUMN public.data_syncs.error_type IS
  'Nature de l''échec. ''write_error'' = les données ont été récupérées mais '
  'une ou plusieurs écritures en base ont échoué (run dégradé, '
  'sync_status=''completed_with_errors'' ou ''failed''), par opposition aux six '
  'autres valeurs qui décrivent un échec d''appel à une API externe.';
