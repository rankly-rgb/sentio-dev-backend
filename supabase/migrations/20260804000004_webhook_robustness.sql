-- ============================================================
-- Robustesse ingestion webhook (Phase 2.6, docs/openspec.md §10)
--
-- 1. subscriptions.last_event_created_at : garde d'ordonnancement — stocke
--    le timestamp `event.created` Stripe le plus récent appliqué à cette
--    subscription. stripe-webhook compare tout nouvel event à cette valeur
--    et ignore (log, ne throw pas) un event plus ancien plutôt que
--    d'écraser un état plus récent avec des données périmées (les webhooks
--    Stripe ne sont pas garantis livrés dans l'ordre).
--
-- 2. invoices.status élargi avec 'refunded' — charge.refunded et
--    credit_note.created (nouveaux événements routés) mettent à jour ce
--    statut, jamais mrr_movements/score_history rétroactivement
--    (docs/openspec.md §10 : l'historique n'est jamais réécrit
--    silencieusement — c'est un statut d'invoice, pas une correction).
-- ============================================================

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS last_event_created_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.subscriptions.last_event_created_at IS
  'event.created (Stripe) du dernier webhook appliqué à cette subscription — garde d''ordonnancement (docs/openspec.md §10). NULL si jamais touchée par un webhook (uniquement synchronisée via sync-stripe).';

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_status_check CHECK (
    status = ANY (ARRAY['draft', 'open', 'paid', 'void', 'uncollectible', 'refunded'])
  );
