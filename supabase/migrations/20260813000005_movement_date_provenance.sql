-- Lot 4 (2026-08-13, movement_date provenance) — subscriptions.stripe_created_at
-- + mrr_movements.provenance
--
-- Root cause (audit Phase 0, confirmé par lecture de code) : sync-stripe
-- (chemin batch, syncSubscriptions/syncInvoices — pas stripe-webhook, qui
-- date déjà correctement TOUS les types via event.created) ne date
-- correctement que le type `churn` (via subscriptions.canceled_at, déjà
-- persisté). Les types `new`/`expansion`/`contraction` sont écrasés à la
-- date du jour du run — alors que `sub.created` (une date Stripe réelle)
-- était déjà lue en mémoire (sync-stripe/index.ts, accountSubMeta) sans
-- jamais être ni persistée, ni utilisée pour dater un mouvement `new`.
--
-- stripe_created_at : persiste la date de création Stripe par
-- subscription — nécessaire pour dater un mouvement `new` avec la même
-- précision que `churn` utilise déjà `canceled_at`.
--
-- provenance : colonne créée ici plutôt qu'au Lot 6 (backfill), c'est son
-- endroit naturel — dès ce lot, `expansion`/`contraction` (chemin batch
-- diff, réellement indatables avec une date réelle, confirmé par l'audit :
-- aucune colonne persistée ne capture un changement de MRR partiel à un
-- instant donné, et l'API Events Stripe ne remonte pas au-delà de 30
-- jours) sont datés à la date de traitement ET marqués 'estimated' — pas
-- de date fabriquée silencieusement (S1, "no data ≠ neutral data" appliqué
-- au temps).

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS stripe_created_at TIMESTAMPTZ NULL;

ALTER TABLE public.mrr_movements
  ADD COLUMN IF NOT EXISTS provenance TEXT NOT NULL DEFAULT 'live';

ALTER TABLE public.mrr_movements
  DROP CONSTRAINT IF EXISTS mrr_movements_provenance_check;

ALTER TABLE public.mrr_movements
  ADD CONSTRAINT mrr_movements_provenance_check CHECK (
    provenance = ANY (ARRAY['live','backfill','estimated'])
  );

-- upsert_mrr_movements_sync (20260808000001) gagne la colonne provenance —
-- même signature exacte (rows JSONB), CREATE OR REPLACE sûr à rejouer.
-- Défaut 'live' si l'appelant ne la fournit pas (compat descendante avec
-- tout appelant qui n'aurait pas encore été redéployé).
CREATE OR REPLACE FUNCTION public.upsert_mrr_movements_sync(rows JSONB)
RETURNS VOID
LANGUAGE SQL
SET search_path = public
AS $$
  INSERT INTO public.mrr_movements (
    organization_id, account_id, movement_type, amount_cents, movement_date, stripe_event_id, provenance
  )
  SELECT
    (r->>'organization_id')::UUID,
    (r->>'account_id')::UUID,
    r->>'movement_type',
    (r->>'amount_cents')::INTEGER,
    (r->>'movement_date')::DATE,
    NULL::TEXT,
    COALESCE(r->>'provenance', 'live')
  FROM jsonb_array_elements(rows) AS r
  ON CONFLICT (organization_id, account_id, movement_date, movement_type)
    WHERE stripe_event_id IS NULL
  DO NOTHING;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_mrr_movements_sync(JSONB) TO service_role;
