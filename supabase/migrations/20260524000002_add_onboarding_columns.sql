-- ============================================================
-- Migration : Colonnes onboarding dans organizations
-- stripe_account_id existe déjà — on ajoute le reste
-- ============================================================

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS stripe_connected          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_connection_method  TEXT CHECK (
    stripe_connection_method IN ('api_key', 'oauth')
  ),
  ADD COLUMN IF NOT EXISTS hubspot_connected          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at   TIMESTAMPTZ;
