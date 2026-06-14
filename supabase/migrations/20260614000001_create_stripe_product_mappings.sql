-- Migration : création de la table stripe_product_mappings
-- Fait le lien entre un stripe_price_id et les données métier (plan_tier, seat_limit)
-- Chaque organisation configure ce mapping une seule fois ; sync-stripe l'utilise à chaque run.
-- seat_limit = NULL signifie "non configuré" (pas illimité).
-- unlimited_seats = TRUE = plan sans plafond de sièges (expansion_score en mode absolu).

CREATE TABLE IF NOT EXISTS stripe_product_mappings (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_price_id      TEXT        NOT NULL,
  stripe_product_name  TEXT,
  stripe_price_label   TEXT,
  plan_tier            TEXT        CHECK (plan_tier IN ('starter', 'growth', 'enterprise')),
  seat_limit           INTEGER     CHECK (seat_limit IS NULL OR seat_limit > 0),
  unlimited_seats      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT stripe_product_mappings_org_price_unique
    UNIQUE (organization_id, stripe_price_id)
);

CREATE INDEX IF NOT EXISTS idx_stripe_product_mappings_org
  ON stripe_product_mappings (organization_id);

CREATE INDEX IF NOT EXISTS idx_stripe_product_mappings_price
  ON stripe_product_mappings (organization_id, stripe_price_id);

ALTER TABLE stripe_product_mappings ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'stripe_product_mappings'
      AND policyname = 'stripe_product_mappings_org_isolation'
  ) THEN
    CREATE POLICY "stripe_product_mappings_org_isolation"
      ON stripe_product_mappings FOR ALL
      USING (
        organization_id = public.user_organization_id()
        OR public.user_role() = 'service_role'
      );
  END IF;
END $$;

CREATE TRIGGER update_stripe_product_mappings_updated_at
  BEFORE UPDATE ON stripe_product_mappings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
