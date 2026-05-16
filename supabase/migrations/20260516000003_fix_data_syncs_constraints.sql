-- ============================================================
-- Migration : Fix data_syncs CHECK constraints
--
-- Problème 1 : error_type CHECK n'incluait pas 'timeout'
--   → self-monitor échoue silencieusement quand il auto-fail des syncs bloqués
--
-- Problème 2 : coherence CHECK (records_processed >= records_failed)
--   → viole quand des invoices orphelines sont comptées comme records_failed
--   → logger.complete() échoue silencieusement → sync reste 'running' indéfiniment
--
-- Fix : relaxer la coherence CHECK (records_failed peut dépasser records_processed
--   dans les cas légitimes), et ajouter 'timeout' à error_type.
-- ============================================================

-- Fix 1 : Ajouter 'timeout' aux error_type autorisés
ALTER TABLE public.data_syncs DROP CONSTRAINT IF EXISTS data_syncs_error_type_check;

ALTER TABLE public.data_syncs ADD CONSTRAINT data_syncs_error_type_check
  CHECK (
    error_type = ANY (ARRAY[
      'api_error',
      'network_error',
      'validation_error',
      'rate_limit',
      'auth_error',
      'timeout'
    ])
    OR error_type IS NULL
  );

-- Fix 2 : Supprimer la coherence CHECK trop stricte
-- records_failed peut légitimement dépasser records_processed (ex: invoices orphelines)
ALTER TABLE public.data_syncs DROP CONSTRAINT IF EXISTS data_syncs_records_coherence_check;
