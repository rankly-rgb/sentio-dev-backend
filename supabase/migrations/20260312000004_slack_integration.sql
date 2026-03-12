-- ============================================================
-- Migration : Support Slack Bot Token dans organization_integrations
-- Permet de connecter un workspace Slack par clé API (Bot Token xoxb-)
-- au lieu du webhook global unique.
-- ============================================================

-- 1. Étendre le CHECK provider pour inclure 'slack'
ALTER TABLE public.organization_integrations
  DROP CONSTRAINT IF EXISTS organization_integrations_provider_check;

ALTER TABLE public.organization_integrations
  ADD CONSTRAINT organization_integrations_provider_check CHECK (
    provider = ANY (ARRAY['stripe', 'hubspot', 'slack'])
  );

-- 2. Ajouter slack_team_id à organizations (identifiant du workspace Slack)
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS slack_team_id TEXT NULL;

-- 3. Étendre oauth_states pour accepter le provider slack (si CHECK existe)
ALTER TABLE public.oauth_states
  DROP CONSTRAINT IF EXISTS oauth_states_provider_check;

ALTER TABLE public.oauth_states
  ADD CONSTRAINT oauth_states_provider_check CHECK (
    provider = ANY (ARRAY['stripe', 'hubspot', 'slack'])
  );
