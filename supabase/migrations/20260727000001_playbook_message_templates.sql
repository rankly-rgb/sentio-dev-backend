-- ============================================================
-- Playbooks actionnables — bibliothèque de templates de message
-- Table : playbook_message_templates
-- cf. specs/001-playbooks-export-csv/data-model.md
-- ============================================================

CREATE TABLE IF NOT EXISTS playbook_message_templates (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_category TEXT NOT NULL CHECK (template_category IN (
    'churn_prevention', 'expansion', 'renewal', 'payment_recovery', 'reactivation'
  )),
  name              TEXT NOT NULL CHECK (char_length(trim(name)) > 0),
  body              TEXT NOT NULL CHECK (char_length(trim(body)) > 0 AND char_length(body) <= 2000),
  is_active         BOOLEAN NOT NULL DEFAULT true,
  is_default        BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE playbook_message_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "playbook_message_templates_org_isolation"
ON playbook_message_templates FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

CREATE INDEX IF NOT EXISTS idx_playbook_message_templates_org
  ON playbook_message_templates (organization_id);

CREATE INDEX IF NOT EXISTS idx_playbook_message_templates_category
  ON playbook_message_templates (organization_id, template_category, is_active);

-- Un seul template par défaut par (organization_id, template_category)
CREATE UNIQUE INDEX IF NOT EXISTS idx_playbook_message_templates_one_default
  ON playbook_message_templates (organization_id, template_category)
  WHERE is_default = true;

CREATE TRIGGER update_playbook_message_templates_updated_at
  BEFORE UPDATE ON playbook_message_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
