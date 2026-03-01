-- ============================================================
-- Migration 004 : Phase 3 — Analytics (données calculées)
-- Tables : score_history, account_segments, segment_memberships,
--          cohorts, retention_metrics
-- ============================================================

-- ------------------------------------------------------------
-- 3.1 score_history — Snapshots quotidiens des scores par compte
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.score_history (
  id                  UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL,
  account_id          UUID NOT NULL,

  snapshot_date       DATE NOT NULL,
  health_score        NUMERIC(5,2) NULL,
  churn_risk_score    NUMERIC(5,2) NULL,
  expansion_score     NUMERIC(5,2) NULL,
  product_usage_score NUMERIC(5,2) NULL,
  mrr_cents           INTEGER NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT score_history_pkey PRIMARY KEY (id),
  CONSTRAINT score_history_org_account_date_key UNIQUE (organization_id, account_id, snapshot_date),
  CONSTRAINT score_history_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT score_history_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  CONSTRAINT score_history_health_check CHECK (
    health_score BETWEEN 0 AND 100 OR health_score IS NULL
  ),
  CONSTRAINT score_history_churn_check CHECK (
    churn_risk_score BETWEEN 0 AND 100 OR churn_risk_score IS NULL
  ),
  CONSTRAINT score_history_expansion_check CHECK (
    expansion_score BETWEEN 0 AND 100 OR expansion_score IS NULL
  ),
  CONSTRAINT score_history_usage_check CHECK (
    product_usage_score BETWEEN 0 AND 100 OR product_usage_score IS NULL
  )
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_score_history_org ON public.score_history USING btree (organization_id);
CREATE INDEX IF NOT EXISTS idx_score_history_account_date ON public.score_history USING btree (account_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_score_history_health ON public.score_history USING btree (organization_id, health_score DESC, snapshot_date DESC);

DROP TRIGGER IF EXISTS update_score_history_updated_at ON public.score_history;
CREATE TRIGGER update_score_history_updated_at
  BEFORE UPDATE ON public.score_history
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.score_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "score_history_org_isolation" ON public.score_history;
CREATE POLICY "score_history_org_isolation"
ON public.score_history FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

-- ------------------------------------------------------------
-- 3.2 account_segments — Segmentation dynamique (8 segments SaaS B2B)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.account_segments (
  id                       UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id          UUID NOT NULL,

  segment_name             TEXT NOT NULL,
  segment_type             TEXT NOT NULL,
  priority                 TEXT NOT NULL DEFAULT 'medium',
  criteria                 JSONB NOT NULL,
  description              TEXT NULL,

  -- Métriques calculées
  account_count            INTEGER NOT NULL DEFAULT 0,
  mrr_total_cents          INTEGER NOT NULL DEFAULT 0,
  avg_health_score         NUMERIC(5,2) NULL,
  avg_churn_risk           NUMERIC(5,2) NULL,
  previous_account_count   INTEGER NULL,
  account_count_change     INTEGER NULL,
  growth_rate              NUMERIC(5,2) NULL,

  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  is_system_generated      BOOLEAN NOT NULL DEFAULT FALSE,
  last_calculated_at       TIMESTAMPTZ NULL,
  next_calculation_at      TIMESTAMPTZ NULL,
  calculation_frequency    TEXT NOT NULL DEFAULT 'daily',

  -- Alertes
  alert_enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  alert_threshold_pct      NUMERIC(5,2) NULL,
  last_alert_sent_at       TIMESTAMPTZ NULL,

  created_by               UUID NULL REFERENCES public.profiles_(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT account_segments_pkey PRIMARY KEY (id),
  CONSTRAINT account_segments_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT account_segments_segment_type_check CHECK (
    segment_type = ANY (ARRAY[
      'champions','en_expansion','stables','a_risque_leger',
      'en_danger_critique','impayes','en_churn','nouveaux'
    ])
  ),
  CONSTRAINT account_segments_priority_check CHECK (
    priority = ANY (ARRAY['low','medium','high','critical'])
  ),
  CONSTRAINT account_segments_calculation_frequency_check CHECK (
    calculation_frequency = ANY (ARRAY['realtime','daily','weekly'])
  )
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_account_segments_org ON public.account_segments USING btree (organization_id);
CREATE INDEX IF NOT EXISTS idx_account_segments_type ON public.account_segments USING btree (organization_id, segment_type)
  WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_account_segments_next_calc ON public.account_segments USING btree (next_calculation_at)
  WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_account_segments_criteria ON public.account_segments USING gin (criteria);

DROP TRIGGER IF EXISTS update_account_segments_updated_at ON public.account_segments;
CREATE TRIGGER update_account_segments_updated_at
  BEFORE UPDATE ON public.account_segments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.account_segments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "account_segments_org_isolation" ON public.account_segments;
CREATE POLICY "account_segments_org_isolation"
ON public.account_segments FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

-- ------------------------------------------------------------
-- 3.3 segment_memberships — Appartenance aux segments
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.segment_memberships (
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL,
  segment_id       UUID NOT NULL,
  account_id       UUID NOT NULL,

  status           VARCHAR(20) NOT NULL DEFAULT 'active',
  added_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exited_at        TIMESTAMPTZ NULL,
  exit_reason      TEXT NULL,
  last_evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_type      VARCHAR(50) NOT NULL DEFAULT 'ai_generated',
  risk_score       NUMERIC(5,2) NULL,
  confidence_score NUMERIC(5,2) NULL,
  notes            TEXT NULL,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT segment_memberships_pkey PRIMARY KEY (id),
  CONSTRAINT segment_memberships_segment_account_key UNIQUE (segment_id, account_id),
  CONSTRAINT segment_memberships_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT segment_memberships_segment_id_fkey FOREIGN KEY (segment_id)
    REFERENCES public.account_segments(id) ON DELETE CASCADE,
  CONSTRAINT segment_memberships_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  CONSTRAINT segment_memberships_status_check CHECK (
    status = ANY (ARRAY['active','exited','paused'])
  ),
  CONSTRAINT segment_memberships_exit_coherence_check CHECK (
    (status = 'exited' AND exit_reason IS NOT NULL AND exited_at IS NOT NULL)
    OR status <> 'exited'
  ),
  CONSTRAINT segment_memberships_risk_check CHECK (
    risk_score BETWEEN 0 AND 100 OR risk_score IS NULL
  ),
  CONSTRAINT segment_memberships_confidence_check CHECK (
    confidence_score BETWEEN 0 AND 100 OR confidence_score IS NULL
  )
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_segment_memberships_org ON public.segment_memberships USING btree (organization_id);
CREATE INDEX IF NOT EXISTS idx_segment_memberships_segment ON public.segment_memberships USING btree (segment_id, status);
CREATE INDEX IF NOT EXISTS idx_segment_memberships_account ON public.segment_memberships USING btree (account_id, status);
CREATE INDEX IF NOT EXISTS idx_segment_memberships_active ON public.segment_memberships USING btree (segment_id, account_id)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS update_segment_memberships_updated_at ON public.segment_memberships;
CREATE TRIGGER update_segment_memberships_updated_at
  BEFORE UPDATE ON public.segment_memberships
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.segment_memberships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "segment_memberships_org_isolation" ON public.segment_memberships;
CREATE POLICY "segment_memberships_org_isolation"
ON public.segment_memberships FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

-- ------------------------------------------------------------
-- 3.4 cohorts — Analyse de cohortes SaaS (MRR-based)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cohorts (
  id                        UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id           UUID NOT NULL,

  cohort_month              DATE NOT NULL,
  cohort_name               TEXT NULL,
  total_accounts            INTEGER NOT NULL DEFAULT 0,
  total_mrr_cents           INTEGER NOT NULL DEFAULT 0,
  avg_mrr_per_account_cents INTEGER NULL,

  -- Rétention par mois (logo et MRR)
  retention_by_month        JSONB NULL,
  month_1_retention         NUMERIC(5,2) NULL,
  month_3_retention         NUMERIC(5,2) NULL,
  month_6_retention         NUMERIC(5,2) NULL,
  month_12_retention        NUMERIC(5,2) NULL,
  nrr_month_12              NUMERIC(5,2) NULL,

  churn_rate                NUMERIC(5,2) NULL,
  expansion_rate            NUMERIC(5,2) NULL,
  calculated_at             TIMESTAMPTZ NULL,
  data_completeness_pct     NUMERIC(5,2) NULL,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT cohorts_pkey PRIMARY KEY (id),
  CONSTRAINT cohorts_org_month_key UNIQUE (organization_id, cohort_month),
  CONSTRAINT cohorts_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT cohorts_retention_check CHECK (
    (month_1_retention BETWEEN 0 AND 200 OR month_1_retention IS NULL)
    AND (month_3_retention BETWEEN 0 AND 200 OR month_3_retention IS NULL)
    AND (month_6_retention BETWEEN 0 AND 200 OR month_6_retention IS NULL)
    AND (month_12_retention BETWEEN 0 AND 200 OR month_12_retention IS NULL)
  ),
  CONSTRAINT cohorts_total_accounts_check CHECK (total_accounts >= 0)
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_cohorts_org ON public.cohorts USING btree (organization_id, cohort_month DESC);
CREATE INDEX IF NOT EXISTS idx_cohorts_retention ON public.cohorts USING gin (retention_by_month);

DROP TRIGGER IF EXISTS update_cohorts_updated_at ON public.cohorts;
CREATE TRIGGER update_cohorts_updated_at
  BEFORE UPDATE ON public.cohorts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.cohorts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cohorts_org_isolation" ON public.cohorts;
CREATE POLICY "cohorts_org_isolation"
ON public.cohorts FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

-- ------------------------------------------------------------
-- 3.5 retention_metrics — KPIs quotidiens du dashboard
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.retention_metrics (
  id                         UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id            UUID NOT NULL,

  metric_date                DATE NOT NULL,
  total_accounts_tracked     INTEGER NOT NULL DEFAULT 0,
  active_accounts            INTEGER NOT NULL DEFAULT 0,

  -- MRR breakdown
  mrr_cents                  INTEGER NULL DEFAULT 0,
  arr_cents                  INTEGER NULL DEFAULT 0,
  new_mrr_cents              INTEGER NULL DEFAULT 0,
  expansion_mrr_cents        INTEGER NULL DEFAULT 0,
  contraction_mrr_cents      INTEGER NULL DEFAULT 0,
  churn_mrr_cents            INTEGER NULL DEFAULT 0,
  reactivation_mrr_cents     INTEGER NULL DEFAULT 0,

  -- NRR & Logo Retention
  nrr                        NUMERIC(5,2) NULL,
  logo_retention_rate        NUMERIC(5,2) NULL,

  -- Scores moyens
  avg_health_score           NUMERIC(5,2) NULL,
  avg_churn_risk             NUMERIC(5,2) NULL,

  -- Distribution des comptes par segment
  champions_count            INTEGER NULL DEFAULT 0,
  en_expansion_count         INTEGER NULL DEFAULT 0,
  stables_count              INTEGER NULL DEFAULT 0,
  a_risque_count             INTEGER NULL DEFAULT 0,
  en_danger_count            INTEGER NULL DEFAULT 0,
  impayes_count              INTEGER NULL DEFAULT 0,
  en_churn_count             INTEGER NULL DEFAULT 0,
  nouveaux_count             INTEGER NULL DEFAULT 0,

  -- MRR à risque
  mrr_at_risk_cents          INTEGER NULL DEFAULT 0,
  accounts_at_risk           INTEGER NULL DEFAULT 0,
  expansion_opportunities    INTEGER NULL DEFAULT 0,

  -- Variations vs période précédente
  mrr_change_pct             NUMERIC(5,2) NULL,
  health_score_change        NUMERIC(5,2) NULL,

  calculated_at              TIMESTAMPTZ NULL,
  calculation_version        TEXT NULL DEFAULT 'v1.0',
  data_completeness_pct      NUMERIC(5,2) NULL,

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT retention_metrics_pkey PRIMARY KEY (id),
  CONSTRAINT retention_metrics_org_date_key UNIQUE (organization_id, metric_date),
  CONSTRAINT retention_metrics_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT retention_metrics_health_check CHECK (
    avg_health_score BETWEEN 0 AND 100 OR avg_health_score IS NULL
  ),
  CONSTRAINT retention_metrics_churn_risk_check CHECK (
    avg_churn_risk BETWEEN 0 AND 100 OR avg_churn_risk IS NULL
  ),
  CONSTRAINT retention_metrics_counts_check CHECK (
    total_accounts_tracked >= 0 AND active_accounts >= 0
  ),
  CONSTRAINT retention_metrics_data_completeness_check CHECK (
    data_completeness_pct BETWEEN 0 AND 100 OR data_completeness_pct IS NULL
  )
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_retention_metrics_org_date ON public.retention_metrics USING btree (organization_id, metric_date DESC);
CREATE INDEX IF NOT EXISTS idx_retention_metrics_mrr ON public.retention_metrics USING btree (organization_id, mrr_cents DESC);

DROP TRIGGER IF EXISTS update_retention_metrics_updated_at ON public.retention_metrics;
CREATE TRIGGER update_retention_metrics_updated_at
  BEFORE UPDATE ON public.retention_metrics
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.retention_metrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "retention_metrics_org_isolation" ON public.retention_metrics;
CREATE POLICY "retention_metrics_org_isolation"
ON public.retention_metrics FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);
