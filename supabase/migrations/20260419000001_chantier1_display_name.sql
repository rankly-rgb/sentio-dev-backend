-- ============================================================
-- Migration : Chantier 1 — Alias des comptes
-- Ajoute display_name (alias métier libre) sur la table accounts.
-- Jamais synchronisé depuis Stripe ou HubSpot — donnée Sentio pure.
-- ============================================================

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS display_name TEXT NULL;

COMMENT ON COLUMN public.accounts.display_name IS
  'Alias métier libre, saisi manuellement dans Sentio. Jamais synchronisé depuis Stripe ou HubSpot.';

-- Index partiel pour la recherche par nom dans une org
CREATE INDEX IF NOT EXISTS idx_accounts_display_name
  ON public.accounts (organization_id, display_name)
  WHERE display_name IS NOT NULL;
