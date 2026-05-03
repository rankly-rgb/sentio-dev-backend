-- ============================================================
-- Playbook Execution Logs
-- Table : playbook_execution_logs
-- Journal immuable de chaque déclenchement d'une playbook_destination.
--
-- CONTRAINTE ZERO-PII CRITIQUE :
--   Aucune colonne ne contient d'email, nom, téléphone, adresse ou IP.
--   stripe_customer_id est un identifiant opaque Stripe (ex: cus_xxx).
--   L'email client transite uniquement en mémoire dans playbook-executor
--   (< 500ms) et n'est JAMAIS persisté dans cette table ni ailleurs.
-- ============================================================

CREATE TABLE IF NOT EXISTS playbook_execution_logs (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  destination_id           UUID        NOT NULL REFERENCES playbook_destinations(id) ON DELETE CASCADE,
  account_id               UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Identifiant opaque Stripe — Zero-PII (pas d'email, nom, etc.)
  stripe_customer_id       TEXT        NOT NULL,
  connector                TEXT        NOT NULL,
  trigger_reason           TEXT        NOT NULL CHECK (trigger_reason IN (
                             'segment_change', 'churn_threshold', 'invoice_past_due', 'manual'
                           )),
  -- Contexte du déclenchement (métriques au moment du trigger)
  segment_at_trigger       TEXT,
  churn_risk_at_trigger    NUMERIC(5,2),
  mrr_cents_at_trigger     INTEGER,
  -- Résultat de l'appel au connecteur
  success                  BOOLEAN     NOT NULL DEFAULT false,
  http_status              INTEGER,
  -- Tronqué à 500 chars, sans PII
  error_message            TEXT,
  -- Tronqué à 500 chars, sans PII
  connector_response       TEXT,
  executed_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE playbook_execution_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "playbook_execution_logs_org_isolation"
ON playbook_execution_logs FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

CREATE INDEX IF NOT EXISTS idx_playbook_execution_logs_org
  ON playbook_execution_logs (organization_id);

CREATE INDEX IF NOT EXISTS idx_playbook_execution_logs_destination
  ON playbook_execution_logs (destination_id);

CREATE INDEX IF NOT EXISTS idx_playbook_execution_logs_account
  ON playbook_execution_logs (account_id);

CREATE INDEX IF NOT EXISTS idx_playbook_execution_logs_success
  ON playbook_execution_logs (organization_id, success);

CREATE INDEX IF NOT EXISTS idx_playbook_execution_logs_executed_at
  ON playbook_execution_logs (organization_id, executed_at DESC);

CREATE TRIGGER update_playbook_execution_logs_updated_at
  BEFORE UPDATE ON playbook_execution_logs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
