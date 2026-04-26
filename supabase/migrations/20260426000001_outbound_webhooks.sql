-- ============================================================
-- Outbound Webhook System
-- Tables : outbound_webhook_destinations, outbound_webhook_logs
-- Étend : webhook_dead_letter (provider CHECK)
-- ============================================================

-- ── Étendre le CHECK de webhook_dead_letter pour le provider 'outbound' ──────
ALTER TABLE webhook_dead_letter
  DROP CONSTRAINT IF EXISTS webhook_dead_letter_provider_check;

ALTER TABLE webhook_dead_letter
  ADD CONSTRAINT webhook_dead_letter_provider_check
  CHECK (provider IN ('stripe', 'hubspot', 'usage', 'outbound'));

-- ── Table : outbound_webhook_destinations ────────────────────────────────────
CREATE TABLE IF NOT EXISTS outbound_webhook_destinations (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  destination_url      TEXT NOT NULL,
  provider             TEXT NOT NULL CHECK (provider IN ('brevo','mailchimp','lemlist','activecampaign','slack','custom')),
  is_active            BOOLEAN NOT NULL DEFAULT true,
  trigger_segments     TEXT[] NOT NULL DEFAULT '{}',
  trigger_churn_threshold INTEGER,
  secret_header_name   TEXT,
  secret_header_value  TEXT,
  last_triggered_at    TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE outbound_webhook_destinations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "outbound_webhook_destinations_org_isolation"
ON outbound_webhook_destinations FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

CREATE INDEX IF NOT EXISTS idx_outbound_webhook_destinations_org
  ON outbound_webhook_destinations (organization_id);

CREATE INDEX IF NOT EXISTS idx_outbound_webhook_destinations_active
  ON outbound_webhook_destinations (organization_id, is_active)
  WHERE is_active = true;

CREATE TRIGGER update_outbound_webhook_destinations_updated_at
  BEFORE UPDATE ON outbound_webhook_destinations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Table : outbound_webhook_logs ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outbound_webhook_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  destination_id    UUID NOT NULL REFERENCES outbound_webhook_destinations(id) ON DELETE CASCADE,
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  payload           JSONB NOT NULL,
  response_status   INTEGER,
  response_body     TEXT,
  success           BOOLEAN NOT NULL DEFAULT false,
  triggered_by      TEXT NOT NULL CHECK (triggered_by IN ('segment_change', 'churn_threshold', 'manual')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE outbound_webhook_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "outbound_webhook_logs_org_isolation"
ON outbound_webhook_logs FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

CREATE INDEX IF NOT EXISTS idx_outbound_webhook_logs_org
  ON outbound_webhook_logs (organization_id);

CREATE INDEX IF NOT EXISTS idx_outbound_webhook_logs_destination
  ON outbound_webhook_logs (destination_id);

CREATE INDEX IF NOT EXISTS idx_outbound_webhook_logs_success
  ON outbound_webhook_logs (organization_id, success, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_outbound_webhook_logs_created_at
  ON outbound_webhook_logs (created_at DESC);

CREATE TRIGGER update_outbound_webhook_logs_updated_at
  BEFORE UPDATE ON outbound_webhook_logs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
