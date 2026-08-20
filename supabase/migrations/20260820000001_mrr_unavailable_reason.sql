-- ============================================================
-- mrr_unavailable_reason — mission réconciliation Stripe, point 2 (2026-08-20)
--
-- `mrr_status='unavailable'` recouvrait jusqu'ici 3 causes distinctes sans
-- qu'aucune ne soit exposée au frontend : aucune subscription Stripe connue
-- (invoice-only ou jamais synchronisé), subscription non-chiffrable
-- (metered, unit_amount null), devise minoritaire exclue du total de l'org.
-- Le frontend affichait un unique texte générique ("Not billable (known
-- billing limitation)") quelle que soit la raison réelle — voir
-- API_CONTRACTS.md pour le contrat consommé côté client.
--
-- Un compte churné (toutes subscriptions canceled) N'EST PAS concerné :
-- `aggregateAccountMrr` retourne mrr_status='ok'/mrr_cents=0 pour ce cas,
-- déjà affiché correctement comme "$0.00" — pas une 4e valeur ici, cette
-- hypothèse de l'audit ne tenait pas au niveau de ce champ (voir
-- _shared/mrr-engine.ts, commentaire sur MrrUnavailableReason).
--
-- Additif uniquement, comme la migration MRR Engine v2 dont elle est la
-- suite directe (20260804000001) : aucune colonne existante n'est modifiée.
-- ============================================================

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS mrr_unavailable_reason TEXT NULL;

ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_mrr_unavailable_reason_check;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_mrr_unavailable_reason_check CHECK (
    mrr_unavailable_reason = ANY (ARRAY['no_subscription_data', 'unsupported_pricing', 'currency_mismatch'])
    OR mrr_unavailable_reason IS NULL
  );

COMMENT ON COLUMN public.accounts.mrr_unavailable_reason IS
  'Cause structurée de mrr_status=''unavailable'' — ''no_subscription_data'' (aucune subscription Stripe connue : invoice-only ou pas encore synchronisé, croiser avec billing_model pour distinguer les deux), ''unsupported_pricing'' (subscription existante mais non-chiffrable : metered, unit_amount null), ''currency_mismatch'' (devise minoritaire exclue du total de l''org). NULL quand mrr_status=''ok'' (y compris un compte churné à $0 confirmé — jamais assimilé à ce champ). Voir _shared/mrr-engine.ts::MrrUnavailableReason.';

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS mrr_unavailable_reason TEXT NULL;

ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_mrr_unavailable_reason_check;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_mrr_unavailable_reason_check CHECK (
    mrr_unavailable_reason = ANY (ARRAY['unsupported_pricing', 'currency_mismatch'])
    OR mrr_unavailable_reason IS NULL
  );

COMMENT ON COLUMN public.subscriptions.mrr_unavailable_reason IS
  'Cause structurée de mrr_status=''unavailable'' pour cette subscription seule — jamais ''no_subscription_data'' à ce niveau (une ligne subscriptions implique par construction qu''une Subscription Stripe existe). Voir _shared/mrr-engine.ts::calcSubscriptionMrrCents.';
