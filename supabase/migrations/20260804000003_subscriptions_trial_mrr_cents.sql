-- ============================================================
-- subscriptions.trial_mrr_cents (Phase 2.5 follow-up)
--
-- Sans cette colonne, une subscription en trial persiste mrr_cents=0 sans
-- que son montant "en pipeline" soit récupérable ailleurs qu'au moment du
-- traitement live (sync-stripe garde le résultat complet de
-- calcSubscriptionMrrCents en mémoire pendant tout un run, mais
-- stripe-webhook doit re-agréger le MRR du compte à partir des lignes déjà
-- persistées en base — sans cette colonne, accounts.trial_mrr_cents
-- serait systématiquement sous-compté côté webhook dès qu'un compte a
-- plusieurs subscriptions dont une seule est touchée par l'event en cours).
-- ============================================================

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS trial_mrr_cents INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_trial_mrr_cents_check;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_trial_mrr_cents_check CHECK (trial_mrr_cents >= 0);

COMMENT ON COLUMN public.subscriptions.trial_mrr_cents IS
  'MRR "en pipeline" de cette subscription si status=trialing (docs/openspec.md §4) — 0 sinon. Permet de ré-agréger accounts.trial_mrr_cents depuis les lignes persistées (stripe-webhook), sans dépendre d''un état en mémoire propre à un run de sync-stripe.';
