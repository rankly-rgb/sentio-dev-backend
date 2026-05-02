-- Migration : stockage des clés API d'intégration par organisation
-- Permet à chaque org de configurer ses propres clés Stripe et HubSpot
-- depuis l'UI, sans dépendre des variables d'env globales du projet.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS stripe_api_key  TEXT NULL,
  ADD COLUMN IF NOT EXISTS hubspot_api_key TEXT NULL;

COMMENT ON COLUMN public.organizations.stripe_api_key  IS 'Clé secrète Stripe de l''org (sk_live_... ou sk_test_...) — non exposée via l''API publique';
COMMENT ON COLUMN public.organizations.hubspot_api_key IS 'Private App token HubSpot de l''org — non exposé via l''API publique';
