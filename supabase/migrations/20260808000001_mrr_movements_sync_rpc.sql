-- ============================================================
-- Correctif : sync-stripe écrit mrr_movements via un RPC natif au lieu
-- d'un .upsert() PostgREST — voir docs/CHANGELOG_STABILITY.md
-- "mrr_movements — upsert cassé depuis la création de la table" (2026-08-08).
--
-- Root cause : sync-stripe/index.ts appelait
--   .upsert(rows, { onConflict: 'organization_id,account_id,movement_date,movement_type' })
-- qui génère un `ON CONFLICT (...)` SANS prédicat. Le seul index unique
-- couvrant ces 4 colonnes est PARTIEL (mrr_movements_sync_idempotency,
-- migration 20260517000001, WHERE stripe_event_id IS NULL) — Postgres ne
-- peut utiliser un index partiel comme arbitre ON CONFLICT que si la
-- requête répète exactement son prédicat WHERE, ce que le client
-- PostgREST (.upsert()) ne sait pas exprimer. Chaque upsert échouait donc
-- avec 42P10 (aucune contrainte unique ne correspond à la spécification
-- ON CONFLICT) — jamais un seul mrr_movements écrit depuis la création de
-- la table (2026-07-05), malgré des centaines de runs sync-stripe
-- rapportés "completed" (l'erreur était jetée via console.error seul,
-- jamais remontée à DataSyncLogger — voir le correctif compagnon dans
-- sync-stripe/index.ts et _shared/mrr-movements-writer.ts).
--
-- Ce RPC exprime nativement `ON CONFLICT (...) WHERE stripe_event_id IS
-- NULL DO NOTHING`, ciblant l'index partiel EXISTANT sans le modifier ni
-- en créer un nouveau. Le prédicat n'est pas un détail — WHERE
-- stripe_event_id IS NULL cape le chemin sync-stripe (batch) à 1
-- mouvement max par compte/jour/type, tout en laissant le chemin
-- stripe-webhook (stripe_event_id renseigné, insert simple contre
-- mrr_movements_stripe_event_id_unique) produire plusieurs mouvements
-- réels le même jour si plusieurs events Stripe distincts l'exigent. Un
-- index unique non-partiel aurait fait entrer ces deux chemins en
-- collision (cf. audit Phase 0). stripe-webhook/index.ts n'est pas
-- touché par cette migration.
--
-- Convention suivie (cf. get_portfolio_snapshot, 20260712000001) :
-- LANGUAGE SQL, pas de SECURITY DEFINER — appelé exclusivement via
-- service_role (sync-stripe), qui bypass déjà RLS. Les fonctions
-- SECURITY DEFINER de ce repo (ex. mark_playbook_executed, 20260802000005 ;
-- handle_new_user, 20260503000004) posent systématiquement SET search_path
-- pour empêcher un search_path de session hostile de détourner une
-- fonction qui s'exécute avec les privilèges de son PROPRIÉTAIRE — un
-- risque qui ne s'applique pas ici (INVOKER : la fonction s'exécute avec
-- les privilèges de service_role, l'appelant réel, pas ceux d'un
-- propriétaire élevé). SET search_path = public reste posé ci-dessous en
-- défense en profondeur (recommandation Supabase générale, cf. advisor
-- "Function Search Path Mutable") même si le risque pratique est faible
-- ici : le seul objet non qualifié du corps de la fonction est
-- jsonb_array_elements, résolu depuis pg_catalog (toujours implicitement
-- en tête de search_path), et mrr_movements est déjà qualifié public.*.
--
-- Idempotente : CREATE OR REPLACE FUNCTION + GRANT sont tous deux sûrs à
-- rejouer.
-- ============================================================

CREATE OR REPLACE FUNCTION public.upsert_mrr_movements_sync(rows JSONB)
RETURNS VOID
LANGUAGE SQL
SET search_path = public
AS $$
  INSERT INTO public.mrr_movements (
    organization_id, account_id, movement_type, amount_cents, movement_date, stripe_event_id
  )
  SELECT
    (r->>'organization_id')::UUID,
    (r->>'account_id')::UUID,
    r->>'movement_type',
    (r->>'amount_cents')::INTEGER,
    (r->>'movement_date')::DATE,
    NULL::TEXT
  FROM jsonb_array_elements(rows) AS r
  ON CONFLICT (organization_id, account_id, movement_date, movement_type)
    WHERE stripe_event_id IS NULL
  DO NOTHING;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_mrr_movements_sync(JSONB) TO service_role;
