-- ============================================================
-- Migration : Support comptes HubSpot-only
-- Rend stripe_customer_id nullable, ajoute data_source,
-- remplace la contrainte UNIQUE par des index partiels.
-- Retro-compatible : tous les comptes existants gardent
-- stripe_customer_id NOT NULL et data_source = 'stripe'.
-- ============================================================

-- 1. Ajouter data_source AVANT de toucher à stripe_customer_id
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS data_source TEXT NOT NULL DEFAULT 'stripe';

ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_data_source_check;

ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_data_source_check
  CHECK (data_source IN ('stripe', 'hubspot', 'both'));

-- 2. Rendre stripe_customer_id nullable
ALTER TABLE public.accounts
  ALTER COLUMN stripe_customer_id DROP NOT NULL;

-- 3. Remplacer la contrainte UNIQUE par des index partiels
-- L'ancienne contrainte empêchait les comptes sans stripe_customer_id
ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_org_stripe_key;

-- Index unique partiel : un seul compte par stripe_customer_id par org (quand présent)
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_org_stripe_unique
  ON public.accounts (organization_id, stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- Index unique partiel : un seul compte par hubspot_company_id par org (quand présent)
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_org_hubspot_unique
  ON public.accounts (organization_id, hubspot_company_id)
  WHERE hubspot_company_id IS NOT NULL;

-- 4. Mettre à jour data_source pour les comptes existants qui ont les deux IDs
UPDATE public.accounts
  SET data_source = 'both'
  WHERE stripe_customer_id IS NOT NULL
    AND hubspot_company_id IS NOT NULL;
