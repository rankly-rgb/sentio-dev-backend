-- ============================================================
-- Migration : Table oauth_states pour les flows OAuth (Stripe, HubSpot)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.oauth_states (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state           TEXT NOT NULL UNIQUE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN ('stripe', 'hubspot')),
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_only" ON public.oauth_states;
CREATE POLICY "service_role_only" ON public.oauth_states
  USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires
  ON public.oauth_states (expires_at);

CREATE INDEX IF NOT EXISTS idx_oauth_states_state
  ON public.oauth_states (state);
