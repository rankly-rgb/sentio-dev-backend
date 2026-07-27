-- ============================================================
-- Mise en œuvre technique du pricing (chantier D)
-- Tables : pricing_tier_limits, sentio_subscriptions
-- Extension : ai_insights_insight_type_check (+ 'plan_limit_warning')
-- cf. specs/003-pricing-billing-implementation/data-model.md
--
-- Rappel de séparation stricte (research.md, risque critique) : ces
-- tables décrivent la facturation de SENTIO auprès de ses organisations
-- clientes — à ne jamais confondre avec `subscriptions`/`invoices`
-- (facturation des clients FINAUX de chaque organisation) ni avec
-- `stripe_product_mappings` (mapping de prix côté clients finaux).
-- ============================================================

-- ── pricing_tier_limits : table de référence statique ────────
-- Pas de RLS org-scopée (donnée de référence globale, pas de PII,
-- lecture depuis toute Edge Function authentifiée via service_role).
CREATE TABLE IF NOT EXISTS pricing_tier_limits (
  plan_tier             TEXT PRIMARY KEY CHECK (plan_tier IN ('free', 'growth', 'scale', 'enterprise')),
  max_active_accounts   INTEGER CHECK (max_active_accounts IS NULL OR max_active_accounts > 0),
  requires_appointment  BOOLEAN NOT NULL,
  alert_threshold_pct   INTEGER NOT NULL DEFAULT 90 CHECK (alert_threshold_pct > 0 AND alert_threshold_pct <= 100),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER update_pricing_tier_limits_updated_at
  BEFORE UPDATE ON pricing_tier_limits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── sentio_subscriptions : abonnement Stripe Billing DE SENTIO ─
CREATE TABLE IF NOT EXISTS sentio_subscriptions (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                 UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  sentio_stripe_customer_id       TEXT NOT NULL UNIQUE,
  sentio_stripe_subscription_id   TEXT NULL,
  plan_tier                       TEXT NOT NULL CHECK (plan_tier IN ('free', 'growth', 'scale', 'enterprise')),
  status                          TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'canceled', 'incomplete')),
  current_period_end              TIMESTAMPTZ NULL,
  cancel_at_period_end            BOOLEAN NOT NULL DEFAULT false,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sentio_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sentio_subscriptions_org_isolation"
ON sentio_subscriptions FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

CREATE INDEX IF NOT EXISTS idx_sentio_subscriptions_org
  ON sentio_subscriptions (organization_id);

CREATE TRIGGER update_sentio_subscriptions_updated_at
  BEFORE UPDATE ON sentio_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Extension additive de ai_insights_insight_type_check ──────
-- Ajoute 'plan_limit_warning' — aucune valeur existante retirée.
ALTER TABLE ai_insights
  DROP CONSTRAINT IF EXISTS ai_insights_insight_type_check;

ALTER TABLE ai_insights
  ADD CONSTRAINT ai_insights_insight_type_check CHECK (
    insight_type = ANY (ARRAY[
      'churn_prediction', 'expansion_opportunity', 'renewal_alert',
      'payment_risk', 'usage_drop', 'plan_limit_warning'
    ])
  );

-- ── Seed pricing_tier_limits ───────────────────────────────────
-- Grille tarifaire confirmée par décision produit (2026-07-27) :
-- free=30, growth=200, scale=750, enterprise=illimité (sur demande).
-- `max_active_accounts = NULL` signifie "illimité" (cf. data-model.md
-- et _shared/pricing.ts) — pas d'ambiguïté "non configuré" à lever ici
-- comme sur stripe_product_mappings.unlimited_seats (domaine distinct :
-- cette table de référence est toujours entièrement seedée pour les 4
-- paliers, il n'existe pas d'état "pas encore configuré" à distinguer).
INSERT INTO pricing_tier_limits (plan_tier, max_active_accounts, requires_appointment, alert_threshold_pct)
VALUES
  ('free',       30,   false, 90),
  ('growth',     200,  false, 90),
  ('scale',      750,  true,  90),
  ('enterprise', NULL, true,  90)
ON CONFLICT (plan_tier) DO NOTHING;
