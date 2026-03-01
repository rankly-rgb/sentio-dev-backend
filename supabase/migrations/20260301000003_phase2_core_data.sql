-- ============================================================
-- Migration 003 : Phase 2 — Core Data SaaS B2B
-- Tables : accounts, subscriptions, invoices, mrr_movements,
--          usage_events, hubspot_companies
-- ============================================================

-- ------------------------------------------------------------
-- 2.1 accounts — Comptes clients (Zero-PII, identifiants anonymes)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.accounts (
  id                    UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Identifiants anonymes (Zero-PII)
  stripe_customer_id    TEXT NOT NULL,
  hubspot_company_id    TEXT NULL,

  -- Plan & facturation
  plan_tier             TEXT NULL,
  billing_interval      TEXT NULL,
  mrr_cents             INTEGER NULL DEFAULT 0,
  arr_cents             INTEGER NULL DEFAULT 0,
  seat_count            INTEGER NULL DEFAULT 0,
  seat_limit            INTEGER NULL,
  contract_start_date   DATE NULL,
  contract_end_date     DATE NULL,

  -- Scores calculés quotidiennement
  health_score          NUMERIC(5,2) NULL,
  churn_risk_score      NUMERIC(5,2) NULL,
  expansion_score       NUMERIC(5,2) NULL,
  product_usage_score   NUMERIC(5,2) NULL,
  scores_calculated_at  TIMESTAMPTZ NULL,

  -- Sync
  last_stripe_sync_at   TIMESTAMPTZ NULL,
  last_hubspot_sync_at  TIMESTAMPTZ NULL,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT accounts_pkey PRIMARY KEY (id),
  CONSTRAINT accounts_org_stripe_key UNIQUE (organization_id, stripe_customer_id),
  CONSTRAINT accounts_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT accounts_plan_tier_check CHECK (
    plan_tier = ANY (ARRAY['starter','growth','enterprise']) OR plan_tier IS NULL
  ),
  CONSTRAINT accounts_billing_interval_check CHECK (
    billing_interval = ANY (ARRAY['monthly','annual']) OR billing_interval IS NULL
  ),
  CONSTRAINT accounts_health_score_check CHECK (
    health_score BETWEEN 0 AND 100 OR health_score IS NULL
  ),
  CONSTRAINT accounts_churn_risk_score_check CHECK (
    churn_risk_score BETWEEN 0 AND 100 OR churn_risk_score IS NULL
  ),
  CONSTRAINT accounts_expansion_score_check CHECK (
    expansion_score BETWEEN 0 AND 100 OR expansion_score IS NULL
  ),
  CONSTRAINT accounts_product_usage_score_check CHECK (
    product_usage_score BETWEEN 0 AND 100 OR product_usage_score IS NULL
  ),
  CONSTRAINT accounts_mrr_cents_check CHECK (mrr_cents >= 0 OR mrr_cents IS NULL),
  CONSTRAINT accounts_seat_count_check CHECK (seat_count >= 0 OR seat_count IS NULL)
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_accounts_org ON public.accounts USING btree (organization_id);
CREATE INDEX IF NOT EXISTS idx_accounts_stripe_id ON public.accounts USING btree (stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_accounts_hubspot_id ON public.accounts USING btree (hubspot_company_id)
  WHERE hubspot_company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_health_score ON public.accounts USING btree (organization_id, health_score DESC);
CREATE INDEX IF NOT EXISTS idx_accounts_churn_risk ON public.accounts USING btree (organization_id, churn_risk_score DESC);
CREATE INDEX IF NOT EXISTS idx_accounts_mrr ON public.accounts USING btree (organization_id, mrr_cents DESC);
CREATE INDEX IF NOT EXISTS idx_accounts_contract_end ON public.accounts USING btree (organization_id, contract_end_date ASC)
  WHERE contract_end_date IS NOT NULL;

DROP TRIGGER IF EXISTS update_accounts_updated_at ON public.accounts;
CREATE TRIGGER update_accounts_updated_at
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "accounts_org_isolation" ON public.accounts;
CREATE POLICY "accounts_org_isolation"
ON public.accounts FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

-- ------------------------------------------------------------
-- 2.2 subscriptions — Abonnements Stripe par compte
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  account_id        UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,

  stripe_sub_id     TEXT NOT NULL,
  stripe_price_id   TEXT NULL,
  stripe_product_id TEXT NULL,
  status            TEXT NOT NULL DEFAULT 'active',

  mrr_cents         INTEGER NOT NULL DEFAULT 0,
  quantity          INTEGER NOT NULL DEFAULT 1,
  trial_end_date    DATE NULL,
  cancel_at         DATE NULL,
  canceled_at       TIMESTAMPTZ NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT subscriptions_stripe_sub_id_key UNIQUE (stripe_sub_id),
  CONSTRAINT subscriptions_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT subscriptions_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  CONSTRAINT subscriptions_status_check CHECK (
    status = ANY (ARRAY['active','past_due','canceled','trialing','paused','incomplete'])
  ),
  CONSTRAINT subscriptions_mrr_cents_check CHECK (mrr_cents >= 0),
  CONSTRAINT subscriptions_quantity_check CHECK (quantity > 0)
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_subscriptions_org ON public.subscriptions USING btree (organization_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_account ON public.subscriptions USING btree (account_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe ON public.subscriptions USING btree (stripe_sub_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON public.subscriptions USING btree (organization_id, status);

DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON public.subscriptions;
CREATE TRIGGER update_subscriptions_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "subscriptions_org_isolation" ON public.subscriptions;
CREATE POLICY "subscriptions_org_isolation"
ON public.subscriptions FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

-- ------------------------------------------------------------
-- 2.3 invoices — Factures Stripe
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invoices (
  id                UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  account_id        UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  subscription_id   UUID NULL REFERENCES public.subscriptions(id) ON DELETE SET NULL,

  stripe_invoice_id TEXT NOT NULL,
  amount_cents      INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'eur',
  status            TEXT NOT NULL DEFAULT 'draft',
  invoice_date      DATE NOT NULL,
  due_date          DATE NULL,
  paid_at           TIMESTAMPTZ NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT invoices_pkey PRIMARY KEY (id),
  CONSTRAINT invoices_stripe_invoice_id_key UNIQUE (stripe_invoice_id),
  CONSTRAINT invoices_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT invoices_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  CONSTRAINT invoices_status_check CHECK (
    status = ANY (ARRAY['draft','open','paid','void','uncollectible'])
  ),
  CONSTRAINT invoices_amount_check CHECK (amount_cents >= 0),
  CONSTRAINT invoices_paid_coherence_check CHECK (
    (status = 'paid' AND paid_at IS NOT NULL) OR status <> 'paid'
  )
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_invoices_org ON public.invoices USING btree (organization_id);
CREATE INDEX IF NOT EXISTS idx_invoices_account ON public.invoices USING btree (account_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON public.invoices USING btree (organization_id, status)
  WHERE status IN ('open','past_due','uncollectible');
CREATE INDEX IF NOT EXISTS idx_invoices_date ON public.invoices USING btree (organization_id, invoice_date DESC);

DROP TRIGGER IF EXISTS update_invoices_updated_at ON public.invoices;
CREATE TRIGGER update_invoices_updated_at
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "invoices_org_isolation" ON public.invoices;
CREATE POLICY "invoices_org_isolation"
ON public.invoices FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

-- ------------------------------------------------------------
-- 2.4 mrr_movements — Mouvements MRR (source de vérité du NRR)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mrr_movements (
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  account_id       UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  subscription_id  UUID NULL REFERENCES public.subscriptions(id) ON DELETE SET NULL,

  movement_type    TEXT NOT NULL,
  amount_cents     INTEGER NOT NULL,
  movement_date    DATE NOT NULL,
  stripe_event_id  TEXT NULL,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT mrr_movements_pkey PRIMARY KEY (id),
  CONSTRAINT mrr_movements_stripe_event_id_key UNIQUE NULLS NOT DISTINCT (stripe_event_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT mrr_movements_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT mrr_movements_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  CONSTRAINT mrr_movements_movement_type_check CHECK (
    movement_type = ANY (ARRAY['new','expansion','contraction','churn','reactivation'])
  )
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_mrr_movements_org ON public.mrr_movements USING btree (organization_id);
CREATE INDEX IF NOT EXISTS idx_mrr_movements_account ON public.mrr_movements USING btree (account_id);
CREATE INDEX IF NOT EXISTS idx_mrr_movements_type ON public.mrr_movements USING btree (organization_id, movement_type, movement_date DESC);
CREATE INDEX IF NOT EXISTS idx_mrr_movements_date ON public.mrr_movements USING btree (organization_id, movement_date DESC);
CREATE INDEX IF NOT EXISTS idx_mrr_movements_stripe ON public.mrr_movements USING btree (stripe_event_id)
  WHERE stripe_event_id IS NOT NULL;

DROP TRIGGER IF EXISTS update_mrr_movements_updated_at ON public.mrr_movements;
CREATE TRIGGER update_mrr_movements_updated_at
  BEFORE UPDATE ON public.mrr_movements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.mrr_movements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mrr_movements_org_isolation" ON public.mrr_movements;
CREATE POLICY "mrr_movements_org_isolation"
ON public.mrr_movements FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

-- ------------------------------------------------------------
-- 2.5 usage_events — Événements d'usage produit (Zero-PII)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.usage_events (
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  account_id       UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,

  event_type       TEXT NOT NULL,
  feature_name     TEXT NULL,
  event_count      INTEGER NOT NULL DEFAULT 1,
  event_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  source           TEXT NOT NULL DEFAULT 'api',

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT usage_events_pkey PRIMARY KEY (id),
  CONSTRAINT usage_events_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT usage_events_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  CONSTRAINT usage_events_event_type_check CHECK (
    event_type = ANY (ARRAY['login','feature_used','api_call','export','report_viewed'])
  ),
  CONSTRAINT usage_events_source_check CHECK (
    source = ANY (ARRAY['api','webhook','manual'])
  ),
  CONSTRAINT usage_events_count_check CHECK (event_count > 0)
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_usage_events_org ON public.usage_events USING btree (organization_id);
CREATE INDEX IF NOT EXISTS idx_usage_events_account ON public.usage_events USING btree (account_id, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_type ON public.usage_events USING btree (organization_id, event_type, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_feature ON public.usage_events USING btree (organization_id, feature_name, event_date DESC)
  WHERE feature_name IS NOT NULL;

DROP TRIGGER IF EXISTS update_usage_events_updated_at ON public.usage_events;
CREATE TRIGGER update_usage_events_updated_at
  BEFORE UPDATE ON public.usage_events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "usage_events_org_isolation" ON public.usage_events;
CREATE POLICY "usage_events_org_isolation"
ON public.usage_events FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

-- ------------------------------------------------------------
-- 2.6 hubspot_companies — Données HubSpot par compte
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hubspot_companies (
  id                   UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  account_id           UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,

  hubspot_company_id   TEXT NOT NULL,
  lifecycle_stage      TEXT NULL,
  nps_score            SMALLINT NULL,
  open_deal_count      INTEGER NULL DEFAULT 0,
  open_ticket_count    INTEGER NULL DEFAULT 0,
  last_meeting_date    DATE NULL,
  last_email_date      DATE NULL,
  last_synced_at       TIMESTAMPTZ NULL,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT hubspot_companies_pkey PRIMARY KEY (id),
  CONSTRAINT hubspot_companies_org_account_key UNIQUE (organization_id, account_id),
  CONSTRAINT hubspot_companies_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT hubspot_companies_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  CONSTRAINT hubspot_companies_nps_check CHECK (
    nps_score BETWEEN 0 AND 10 OR nps_score IS NULL
  ),
  CONSTRAINT hubspot_companies_lifecycle_check CHECK (
    lifecycle_stage = ANY (ARRAY['subscriber','customer','evangelist','other']) OR lifecycle_stage IS NULL
  ),
  CONSTRAINT hubspot_companies_counts_check CHECK (
    open_deal_count >= 0 AND open_ticket_count >= 0
  )
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_hubspot_companies_org ON public.hubspot_companies USING btree (organization_id);
CREATE INDEX IF NOT EXISTS idx_hubspot_companies_account ON public.hubspot_companies USING btree (account_id);
CREATE INDEX IF NOT EXISTS idx_hubspot_companies_hubspot_id ON public.hubspot_companies USING btree (hubspot_company_id);
CREATE INDEX IF NOT EXISTS idx_hubspot_companies_tickets ON public.hubspot_companies USING btree (organization_id, open_ticket_count DESC)
  WHERE open_ticket_count > 0;

DROP TRIGGER IF EXISTS update_hubspot_companies_updated_at ON public.hubspot_companies;
CREATE TRIGGER update_hubspot_companies_updated_at
  BEFORE UPDATE ON public.hubspot_companies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.hubspot_companies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hubspot_companies_org_isolation" ON public.hubspot_companies;
CREATE POLICY "hubspot_companies_org_isolation"
ON public.hubspot_companies FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);
