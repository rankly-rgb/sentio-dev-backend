-- ============================================================
-- Migration : Locale preference per organization
-- ============================================================

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'fr'
    CONSTRAINT organizations_locale_check CHECK (locale IN ('fr', 'en'));

COMMENT ON COLUMN public.organizations.locale IS
  'UI locale preference for the organization. Values: fr (French), en (English).';
