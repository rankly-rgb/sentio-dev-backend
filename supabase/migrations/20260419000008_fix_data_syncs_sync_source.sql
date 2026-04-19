-- ============================================================
-- Migration : Fix data_syncs.sync_source CHECK constraint
-- Ajoute 'scoring' et 'insights' aux valeurs autorisées.
-- Ces valeurs sont utilisées par calculate-scores et generate-insights.
-- ============================================================

ALTER TABLE public.data_syncs DROP CONSTRAINT IF EXISTS data_syncs_sync_source_check;

ALTER TABLE public.data_syncs ADD CONSTRAINT data_syncs_sync_source_check
  CHECK (sync_source = ANY (ARRAY[
    'stripe',
    'hubspot',
    'usage',
    'manual',
    'scoring',
    'insights'
  ]));
