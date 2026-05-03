-- ============================================================
-- Playbook Destinations
-- Table : playbook_destinations
-- Connecteurs d'actions déclenchés sur signal de risque :
--   Brevo, Lemlist, ActiveCampaign, Mailchimp, HubSpot, Slack, custom
--
-- Zero-PII : aucune colonne email, nom, téléphone, adresse, IP.
-- L'email client est récupéré en transit depuis l'API Stripe
-- par playbook-executor et n'est jamais persisté ici.
-- ============================================================

CREATE TABLE IF NOT EXISTS playbook_destinations (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                        TEXT        NOT NULL,
  -- Connecteur externe cible
  connector                   TEXT        NOT NULL CHECK (connector IN (
                                'brevo', 'lemlist', 'activecampaign', 'mailchimp',
                                'hubspot', 'slack', 'custom'
                              )),
  is_active                   BOOLEAN     NOT NULL DEFAULT true,
  -- Segments déclencheurs : 'en_danger_critique', 'a_risque_leger', 'impayes', 'en_churn', etc.
  trigger_segments            TEXT[]      NOT NULL DEFAULT '{}',
  -- Seuil churn_risk_score (0-100). NULL = pas de seuil par score
  trigger_churn_threshold     INTEGER     CHECK (trigger_churn_threshold BETWEEN 0 AND 100),
  -- Déclencher sur invoice.payment_failed
  trigger_on_invoice_past_due BOOLEAN     NOT NULL DEFAULT false,
  -- Clé API du connecteur (V1 : valeur directe ; future migration vers Vault)
  api_key_vault_key           TEXT,
  -- URL endpoint spécifique si custom ou override
  api_endpoint                TEXT,
  -- ID template/liste/séquence côté outil tiers
  template_id                 TEXT,
  -- Template message avec variables : {{stripe_customer_id}}, {{segment}},
  -- {{churn_risk}}, {{mrr_eur}}, {{health_score}}
  message_template            TEXT,
  last_triggered_at           TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Au moins un déclencheur doit être configuré
  CONSTRAINT playbook_destinations_has_trigger CHECK (
    array_length(trigger_segments, 1) > 0
    OR trigger_churn_threshold IS NOT NULL
    OR trigger_on_invoice_past_due = true
  )
);

ALTER TABLE playbook_destinations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "playbook_destinations_org_isolation"
ON playbook_destinations FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

CREATE INDEX IF NOT EXISTS idx_playbook_destinations_org
  ON playbook_destinations (organization_id);

CREATE INDEX IF NOT EXISTS idx_playbook_destinations_active
  ON playbook_destinations (organization_id, is_active)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_playbook_destinations_connector
  ON playbook_destinations (organization_id, connector);

CREATE TRIGGER update_playbook_destinations_updated_at
  BEFORE UPDATE ON playbook_destinations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
