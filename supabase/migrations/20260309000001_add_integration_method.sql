-- ============================================================
-- Ajouter integration_method a organization_integrations
-- Permet de distinguer OAuth Connect vs cle API directe.
-- ============================================================

-- Nouvelle colonne avec default 'oauth' (retro-compatible)
ALTER TABLE public.organization_integrations
  ADD COLUMN IF NOT EXISTS integration_method TEXT NOT NULL DEFAULT 'oauth';

-- CHECK constraint
ALTER TABLE public.organization_integrations
  ADD CONSTRAINT organization_integrations_method_check
  CHECK (integration_method IN ('oauth', 'api_key'));
