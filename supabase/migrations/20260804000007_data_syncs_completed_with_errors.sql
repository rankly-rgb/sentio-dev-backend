-- ============================================================
-- data_syncs.sync_status — nouvelle valeur 'completed_with_errors'
--
-- Incident 2026-08-04 (IMPLEMENTATION_LOG.md, régression PR MRR engine v2) :
-- sync-stripe/index.ts écrivait accounts avec des lignes hétérogènes
-- (billing_model absente sur certaines lignes du même batch upsert),
-- violant la contrainte NOT NULL de la colonne pour tout le chunk. 422
-- comptes en échec par org, records_failed accumulé correctement — mais
-- DataSyncLogger.complete() marquait systématiquement sync_status='completed'
-- quel que soit records_failed, error_message restait NULL malgré une erreur
-- Postgres parfaitement claire ("null value in column billing_model...")
-- déjà capturée par batchUpsert() puis jetée (console.error seulement).
-- Exactement le pattern de succès silencieux que ce chantier existait pour
-- éliminer, reproduit dans son propre code d'observabilité.
--
-- 'completed_with_errors' distingue un run dégradé (une partie du travail a
-- abouti, records_failed > 0) d'un run totalement raté ('failed', réservé
-- aux runs où rien n'a pu être écrit) et d'un run propre ('completed').
-- Voir _shared/data-sync-logger.ts (complete()) pour la logique de choix.
-- ============================================================

ALTER TABLE public.data_syncs
  DROP CONSTRAINT IF EXISTS data_syncs_sync_status_check;

ALTER TABLE public.data_syncs
  ADD CONSTRAINT data_syncs_sync_status_check CHECK (
    sync_status = ANY (ARRAY['pending', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled', 'rate_limited'])
  );
