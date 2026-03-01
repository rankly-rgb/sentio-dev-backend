-- ============================================================
-- Migration 002 : Phase 1 — Infrastructure
-- Tables : organizations, profiles_, invitations,
--          webhook_configs, webhook_dead_letter, cron_locks, sync_metrics
-- ============================================================

-- ------------------------------------------------------------
-- 1.1 organizations — Clients de la plateforme Sentio AI
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.organizations (
  id                    UUID NOT NULL DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  stripe_account_id     TEXT NULL,
  hubspot_portal_id     TEXT NULL,
  plan_type             TEXT NULL DEFAULT 'free',
  is_active             BOOLEAN NULL DEFAULT TRUE,
  onboarding_completed  BOOLEAN NULL DEFAULT FALSE,
  data_model            TEXT NULL DEFAULT 'zero-pii',
  created_at            TIMESTAMPTZ NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NULL DEFAULT NOW(),

  CONSTRAINT organizations_pkey PRIMARY KEY (id),
  CONSTRAINT organizations_stripe_account_id_key UNIQUE (stripe_account_id),
  CONSTRAINT organizations_plan_type_check CHECK (
    plan_type = ANY (ARRAY['free','starter','growth','enterprise'])
  )
) TABLESPACE pg_default;

DROP TRIGGER IF EXISTS update_organizations_updated_at ON public.organizations;
CREATE TRIGGER update_organizations_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "organizations_org_isolation" ON public.organizations;
CREATE POLICY "organizations_org_isolation"
ON public.organizations FOR ALL
USING (
  id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

-- ------------------------------------------------------------
-- 1.2 profiles_ — Utilisateurs internes de Sentio AI
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles_ (
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id  UUID NULL REFERENCES public.organizations(id),
  auth_user_id     UUID NULL,
  email            TEXT NOT NULL,
  role             TEXT NULL DEFAULT 'member',
  full_name        TEXT NULL,
  avatar_url       TEXT NULL,
  last_login_at    TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NULL DEFAULT NOW(),

  CONSTRAINT profiles__pkey PRIMARY KEY (id),
  CONSTRAINT profiles__auth_user_id_key UNIQUE (auth_user_id),
  CONSTRAINT profiles__organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id),
  CONSTRAINT profiles__role_check CHECK (role = ANY (ARRAY['admin','member','viewer']))
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_profiles__auth_user ON public.profiles_ USING btree (auth_user_id);
CREATE INDEX IF NOT EXISTS idx_profiles__org ON public.profiles_ USING btree (organization_id);

DROP TRIGGER IF EXISTS update_profiles__updated_at ON public.profiles_;
CREATE TRIGGER update_profiles__updated_at
  BEFORE UPDATE ON public.profiles_
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.profiles_ ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_org_isolation" ON public.profiles_;
CREATE POLICY "profiles_org_isolation"
ON public.profiles_ FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
  OR auth_user_id = auth.uid()
);

-- ------------------------------------------------------------
-- 1.3 invitations — Système invite-only (bêta)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invitations (
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email            TEXT NOT NULL,
  token            TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'member',
  invited_by       UUID NULL REFERENCES public.profiles_(id) ON DELETE SET NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  accepted_at      TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT invitations_pkey PRIMARY KEY (id),
  CONSTRAINT invitations_token_key UNIQUE (token),
  CONSTRAINT invitations_role_check CHECK (role = ANY (ARRAY['admin','member','viewer']))
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_invitations_token ON public.invitations USING btree (token);
CREATE INDEX IF NOT EXISTS idx_invitations_org ON public.invitations USING btree (organization_id);

DROP TRIGGER IF EXISTS update_invitations_updated_at ON public.invitations;
CREATE TRIGGER update_invitations_updated_at
  BEFORE UPDATE ON public.invitations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "invitations_org_isolation" ON public.invitations;
CREATE POLICY "invitations_org_isolation"
ON public.invitations FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

-- ------------------------------------------------------------
-- 1.4 webhook_configs — Credentials HMAC par org et par provider
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.webhook_configs (
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,
  webhook_secret   TEXT NOT NULL,
  endpoint_url     TEXT NULL,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  last_received_at TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT webhook_configs_pkey PRIMARY KEY (id),
  CONSTRAINT webhook_configs_org_provider_key UNIQUE (organization_id, provider),
  CONSTRAINT webhook_configs_provider_check CHECK (
    provider = ANY (ARRAY['stripe','hubspot','usage'])
  )
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_webhook_configs_org ON public.webhook_configs USING btree (organization_id);

DROP TRIGGER IF EXISTS update_webhook_configs_updated_at ON public.webhook_configs;
CREATE TRIGGER update_webhook_configs_updated_at
  BEFORE UPDATE ON public.webhook_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.webhook_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "webhook_configs_org_isolation" ON public.webhook_configs;
CREATE POLICY "webhook_configs_org_isolation"
ON public.webhook_configs FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

-- ------------------------------------------------------------
-- 1.5 webhook_dead_letter — File de retraitement des webhooks échoués
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.webhook_dead_letter (
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  payload          JSONB NOT NULL,
  error_message    TEXT NULL,
  retry_count      INTEGER NOT NULL DEFAULT 0,
  max_retries      INTEGER NOT NULL DEFAULT 3,
  next_retry_at    TIMESTAMPTZ NULL,
  resolved_at      TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT webhook_dead_letter_pkey PRIMARY KEY (id),
  CONSTRAINT webhook_dead_letter_provider_check CHECK (
    provider = ANY (ARRAY['stripe','hubspot','usage'])
  )
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_wdl_org ON public.webhook_dead_letter USING btree (organization_id);
CREATE INDEX IF NOT EXISTS idx_wdl_retry ON public.webhook_dead_letter USING btree (next_retry_at)
  WHERE resolved_at IS NULL AND retry_count < max_retries;

DROP TRIGGER IF EXISTS update_webhook_dead_letter_updated_at ON public.webhook_dead_letter;
CREATE TRIGGER update_webhook_dead_letter_updated_at
  BEFORE UPDATE ON public.webhook_dead_letter
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.webhook_dead_letter ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "webhook_dead_letter_org_isolation" ON public.webhook_dead_letter;
CREATE POLICY "webhook_dead_letter_org_isolation"
ON public.webhook_dead_letter FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

-- ------------------------------------------------------------
-- 1.6 cron_locks — Verrouillage distribué des cron jobs
--     Pas d'organization_id (table système globale)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cron_locks (
  id          UUID NOT NULL DEFAULT gen_random_uuid(),
  lock_key    TEXT NOT NULL,
  locked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT cron_locks_pkey PRIMARY KEY (id),
  CONSTRAINT cron_locks_lock_key_key UNIQUE (lock_key)
) TABLESPACE pg_default;

DROP TRIGGER IF EXISTS update_cron_locks_updated_at ON public.cron_locks;
CREATE TRIGGER update_cron_locks_updated_at
  BEFORE UPDATE ON public.cron_locks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.cron_locks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cron_locks_service_only" ON public.cron_locks;
CREATE POLICY "cron_locks_service_only"
ON public.cron_locks FOR ALL
USING (public.user_role() = 'service_role');

-- ------------------------------------------------------------
-- 1.7 sync_metrics — Métriques de monitoring des synchronisations
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sync_metrics (
  id                   UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL,
  sync_type            TEXT NOT NULL,
  duration_ms          INTEGER NULL,
  records_processed    INTEGER NULL DEFAULT 0,
  records_created      INTEGER NULL DEFAULT 0,
  records_updated      INTEGER NULL DEFAULT 0,
  records_failed       INTEGER NULL DEFAULT 0,
  success              BOOLEAN NOT NULL DEFAULT TRUE,
  error_message        TEXT NULL,
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT sync_metrics_pkey PRIMARY KEY (id),
  CONSTRAINT sync_metrics_provider_check CHECK (
    provider = ANY (ARRAY['stripe','hubspot','usage'])
  )
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_sync_metrics_org ON public.sync_metrics USING btree (organization_id, synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_metrics_provider ON public.sync_metrics USING btree (provider, synced_at DESC);

DROP TRIGGER IF EXISTS update_sync_metrics_updated_at ON public.sync_metrics;
CREATE TRIGGER update_sync_metrics_updated_at
  BEFORE UPDATE ON public.sync_metrics
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.sync_metrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sync_metrics_org_isolation" ON public.sync_metrics;
CREATE POLICY "sync_metrics_org_isolation"
ON public.sync_metrics FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);
