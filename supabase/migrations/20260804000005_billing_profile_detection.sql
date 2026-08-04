-- ============================================================
-- Détection du profil de facturation (Phase 3, docs/openspec.md §11)
--
-- Point 21 de l'audit (AUDIT_LOGIQUE_METIER_STRIPE.md) : aucune étape de
-- l'onboarding n'inspectait ce que contient réellement le compte Stripe
-- connecté. sync-stripe calcule désormais ces signaux à chaque run
-- (quasi gratuit — données déjà en mémoire pendant le sync, sauf un appel
-- Stripe dédié pour has_subscription_schedules) et les persiste ici.
-- ============================================================

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS billing_profile_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS billing_profile TEXT NOT NULL DEFAULT 'standard';

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_billing_profile_check;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_billing_profile_check CHECK (billing_profile = ANY (ARRAY['standard', 'needs_review']));

COMMENT ON COLUMN public.organizations.billing_profile_flags IS
  'Compteurs bruts calculés par sync-stripe (docs/openspec.md §11) : { metered_subscriptions, multi_item_subscriptions, null_unit_amount_prices, invoice_only_accounts, multi_currency, has_subscription_schedules }. Diagnostic uniquement — ne pilote aucun calcul MRR.';
COMMENT ON COLUMN public.organizations.billing_profile IS
  '''standard'' ou ''needs_review'' — dérivé de billing_profile_flags par sync-stripe. ''needs_review'' quand au moins un signal de configuration Stripe non-standard a été détecté (invoice-only, metered, prix sans unit_amount, multi-devises, subscription schedules). Exposé par onboarding-status et dashboard-api (Phase 3/4).';
