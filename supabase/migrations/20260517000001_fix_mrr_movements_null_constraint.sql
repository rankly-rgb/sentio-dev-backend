-- ============================================================
-- Fix : mrr_movements unique constraint sur stripe_event_id
--
-- La contrainte UNIQUE NULLS NOT DISTINCT empêche d'insérer
-- plusieurs mouvements sans stripe_event_id (cas du sync-stripe).
-- On la remplace par un index partiel uniquement sur les valeurs
-- non-nulles, ce qui préserve l'idempotence webhook tout en
-- permettant les inserts en bulk depuis sync-stripe.
-- ============================================================

ALTER TABLE public.mrr_movements
  DROP CONSTRAINT IF EXISTS mrr_movements_stripe_event_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS mrr_movements_stripe_event_id_unique
  ON public.mrr_movements (stripe_event_id)
  WHERE stripe_event_id IS NOT NULL;

-- Index d'idempotence pour les mouvements générés par sync-stripe
-- (1 mouvement max par compte par date de sync)
CREATE UNIQUE INDEX IF NOT EXISTS mrr_movements_sync_idempotency
  ON public.mrr_movements (organization_id, account_id, movement_date, movement_type)
  WHERE stripe_event_id IS NULL;
