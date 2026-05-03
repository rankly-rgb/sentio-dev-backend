-- ============================================================
-- Approval Queue — Validation humaine avant déclenchement connecteur
--
-- Ajoute require_approval sur playbook_destinations et crée
-- playbook_approval_queue pour les actions en attente de validation.
--
-- Flux : playbook-executor détecte require_approval=true
--        → INSERT dans playbook_approval_queue (pas d'appel connecteur)
--        → CS valide via dashboard → playbook-approve appelle le connecteur
--
-- Zero-PII : mêmes garanties que playbook_execution_logs.
--   stripe_customer_id est un identifiant opaque. Aucun email persisté.
-- ============================================================

-- ── Ajouter require_approval sur playbook_destinations ───────

ALTER TABLE playbook_destinations
  ADD COLUMN IF NOT EXISTS require_approval BOOLEAN NOT NULL DEFAULT false;

-- ── Table : playbook_approval_queue ─────────────────────────

CREATE TABLE IF NOT EXISTS playbook_approval_queue (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  destination_id              UUID        NOT NULL REFERENCES playbook_destinations(id) ON DELETE CASCADE,
  account_id                  UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Identifiant opaque Stripe — Zero-PII
  stripe_customer_id          TEXT        NOT NULL,
  connector                   TEXT        NOT NULL,
  trigger_reason              TEXT        NOT NULL CHECK (trigger_reason IN (
                                'segment_change', 'churn_threshold', 'invoice_past_due', 'manual'
                              )),
  -- Contexte du signal au moment du déclenchement
  segment_at_trigger          TEXT,
  segment_previous            TEXT,
  churn_risk_at_trigger       NUMERIC(5,2),
  health_score_at_trigger     NUMERIC(5,2),
  expansion_score_at_trigger  NUMERIC(5,2),
  mrr_cents_at_trigger        INTEGER,
  -- Statut de validation
  status                      TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN (
                                'pending', 'approved', 'rejected', 'expired'
                              )),
  -- Revue
  reviewed_by                 UUID,       -- auth_user_id du reviewer (pas de FK pour simplicité V1)
  reviewed_at                 TIMESTAMPTZ,
  review_comment              TEXT,
  -- Auto-expiry : non validé après expires_at → statut 'expired' au prochain accès
  expires_at                  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours'),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE playbook_approval_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "playbook_approval_queue_org_isolation"
ON playbook_approval_queue FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

CREATE INDEX IF NOT EXISTS idx_playbook_approval_queue_org
  ON playbook_approval_queue (organization_id);

CREATE INDEX IF NOT EXISTS idx_playbook_approval_queue_pending
  ON playbook_approval_queue (organization_id, status)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_playbook_approval_queue_destination
  ON playbook_approval_queue (destination_id);

CREATE INDEX IF NOT EXISTS idx_playbook_approval_queue_account
  ON playbook_approval_queue (account_id);

CREATE INDEX IF NOT EXISTS idx_playbook_approval_queue_created_at
  ON playbook_approval_queue (organization_id, created_at DESC);

CREATE TRIGGER update_playbook_approval_queue_updated_at
  BEFORE UPDATE ON playbook_approval_queue
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
