-- Migration : table organization_integrations
-- Stocke les intégrations tierces par org avec leur secret dans Supabase Vault.
-- Référencée par resolveHubSpotApiKey() dans _shared/vault.ts (priorité 1).

CREATE TABLE IF NOT EXISTS public.organization_integrations (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider              TEXT        NOT NULL CHECK (provider IN ('hubspot', 'stripe', 'slack')),
  status                TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'error')),
  vault_access_token_id TEXT        NULL,  -- UUID du secret dans Supabase Vault (supabase_vault)
  connected_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider)
);

ALTER TABLE public.organization_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_isolation" ON public.organization_integrations
  USING (organization_id = user_organization_id());

CREATE INDEX IF NOT EXISTS idx_org_integrations_org_provider
  ON public.organization_integrations(organization_id, provider);

COMMENT ON TABLE public.organization_integrations IS
  'Intégrations tierces par organisation. vault_access_token_id pointe vers un secret Supabase Vault.';
COMMENT ON COLUMN public.organization_integrations.vault_access_token_id IS
  'UUID du secret dans vault.secrets (extension supabase_vault). Lire via RPC vault_read_secret().';
