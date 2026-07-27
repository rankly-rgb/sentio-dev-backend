-- ============================================================
-- Playbook Outcome Tracking (chantier C)
-- cf. specs/002-playbook-outcome-tracking/data-model.md
-- ============================================================

-- ── playbooks : fenêtre d'attribution configurable ────────────
ALTER TABLE playbooks
  ADD COLUMN IF NOT EXISTS attribution_window_days INTEGER
    CHECK (attribution_window_days > 0);

-- ── playbook_executions : marquage manuel + attribution + nudge ──
--
-- NB : `manual_executed_at` est une colonne DÉDIÉE au marquage manuel
-- (US1), distincte de la colonne `executed_at` déjà existante sur
-- cette table. `executed_at` a `DEFAULT NOW()` et est déjà peuplée à
-- la création de CHAQUE ligne par playbook-execute/playbook-scheduler
-- (elle représente "quand le système a déclenché l'exécution", pas
-- "quand le CSM a confirmé une action manuelle hors-Sentio"). La
-- réutiliser telle quelle (comme envisagé dans research.md) aurait
-- rendu l'état "not_executed" inatteignable pour toute ligne créée
-- via ces fonctions, et l'idempotence de mark-executed sans effet
-- utile. `manual_executed_at` porte donc la sémantique de ce chantier,
-- exposée sous le nom `executed_at` dans les réponses JSON de l'API
-- (cf. API_CONTRACTS.md § 8.1) sans collision avec la colonne existante.
ALTER TABLE playbook_executions
  ADD COLUMN IF NOT EXISTS manual_executed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attribution_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_via TEXT
    CHECK (resolved_via IN ('invoice_paid_auto', 'manual')),
  ADD COLUMN IF NOT EXISTS nudge_response TEXT
    CHECK (nudge_response IN ('resolved', 'not_resolved', 'unsure')),
  ADD COLUMN IF NOT EXISTS nudge_responded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_playbook_executions_pending_attribution
  ON playbook_executions (organization_id, account_id, attribution_deadline_at)
  WHERE manual_executed_at IS NOT NULL AND account_converted = false;

-- ── playbook_execution_clicks : log de clic Zero-PII (US3) ────
-- Table créée ici (schéma pur, additive) — l'endpoint playbook-link
-- qui l'alimente est un point de gouvernance distinct (cf. tasks.md
-- T022, validation utilisateur explicite requise avant implémentation).
CREATE TABLE IF NOT EXISTS playbook_execution_clicks (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  playbook_execution_id UUID NOT NULL REFERENCES playbook_executions(id) ON DELETE CASCADE,
  stripe_customer_id    TEXT NOT NULL,
  clicked_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE playbook_execution_clicks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "playbook_execution_clicks_org_isolation"
ON playbook_execution_clicks FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

CREATE INDEX IF NOT EXISTS idx_playbook_execution_clicks_org
  ON playbook_execution_clicks (organization_id);

CREATE INDEX IF NOT EXISTS idx_playbook_execution_clicks_execution
  ON playbook_execution_clicks (playbook_execution_id);
