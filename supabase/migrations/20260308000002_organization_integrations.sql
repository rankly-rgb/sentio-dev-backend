-- ============================================================
-- Migration : Tables OAuth multi-tenant
-- 1. organization_integrations — tokens OAuth par org/provider (via Vault)
-- 2. oauth_states — protection CSRF des flux OAuth (TTL 10 min)
-- ============================================================

-- ------------------------------------------------------------
-- 1. organization_integrations
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.organization_integrations (
  id                      UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id         UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider                TEXT NOT NULL,

  -- Tokens stockes via Supabase Vault — jamais en clair
  vault_access_token_id   UUID NULL,
  vault_refresh_token_id  UUID NULL,
  token_expires_at        TIMESTAMPTZ NULL,

  -- Identifiants provider (anonymes, pas des PII)
  provider_account_id     TEXT NULL,
  scopes                  TEXT[] NULL,

  status                  TEXT NOT NULL DEFAULT 'active',
  connected_by            UUID NULL REFERENCES auth.users(id),

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT organization_integrations_pkey PRIMARY KEY (id),
  CONSTRAINT organization_integrations_org_provider_key UNIQUE (organization_id, provider),
  CONSTRAINT organization_integrations_provider_check CHECK (
    provider = ANY (ARRAY['stripe', 'hubspot'])
  ),
  CONSTRAINT organization_integrations_status_check CHECK (
    status = ANY (ARRAY['active', 'pending', 'revoked', 'expired'])
  )
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_org_integrations_org
  ON public.organization_integrations USING btree (organization_id);

CREATE INDEX IF NOT EXISTS idx_org_integrations_provider_status
  ON public.organization_integrations USING btree (provider, status);

DROP TRIGGER IF EXISTS update_organization_integrations_updated_at
  ON public.organization_integrations;
CREATE TRIGGER update_organization_integrations_updated_at
  BEFORE UPDATE ON public.organization_integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.organization_integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_integrations_org_isolation"
  ON public.organization_integrations;
CREATE POLICY "org_integrations_org_isolation"
ON public.organization_integrations FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

-- ------------------------------------------------------------
-- 2. oauth_states — Protection CSRF des flux OAuth
-- TTL 10 minutes, usage unique, nettoyage automatique
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.oauth_states (
  id                UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  state             TEXT NOT NULL,
  redirect_after    TEXT NULL,
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes'),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT oauth_states_pkey PRIMARY KEY (id),
  CONSTRAINT oauth_states_state_key UNIQUE (state),
  CONSTRAINT oauth_states_provider_check CHECK (
    provider = ANY (ARRAY['stripe', 'hubspot'])
  )
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires
  ON public.oauth_states USING btree (expires_at);

CREATE INDEX IF NOT EXISTS idx_oauth_states_state
  ON public.oauth_states USING btree (state);

-- RLS : service_role only (les states sont geres par les Edge Functions)
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "oauth_states_service_role_only"
  ON public.oauth_states;
CREATE POLICY "oauth_states_service_role_only"
ON public.oauth_states FOR ALL
USING (public.user_role() = 'service_role');
