-- ============================================================
-- Migration 005 : Phase 4 — Intelligence & Actions
-- Tables : ai_insights, playbooks, playbook_executions
-- ============================================================

-- ------------------------------------------------------------
-- 4.1 ai_insights — Insights générés par l'IA
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_insights (
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL,
  account_id       UUID NULL REFERENCES public.accounts(id) ON DELETE SET NULL,

  insight_type     TEXT NOT NULL,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  recommended_action TEXT NULL,
  priority         TEXT NOT NULL DEFAULT 'medium',
  confidence_score NUMERIC(5,2) NULL,
  mrr_impact_cents INTEGER NULL,

  status           TEXT NOT NULL DEFAULT 'active',
  acknowledged_at  TIMESTAMPTZ NULL,
  acknowledged_by  UUID NULL REFERENCES public.profiles_(id) ON DELETE SET NULL,
  resolved_at      TIMESTAMPTZ NULL,
  dismissed_at     TIMESTAMPTZ NULL,

  ai_model_version TEXT NULL,
  metadata         JSONB NULL,
  expires_at       TIMESTAMPTZ NULL,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ai_insights_pkey PRIMARY KEY (id),
  CONSTRAINT ai_insights_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT ai_insights_insight_type_check CHECK (
    insight_type = ANY (ARRAY[
      'churn_prediction','expansion_opportunity','renewal_alert',
      'payment_risk','usage_drop'
    ])
  ),
  CONSTRAINT ai_insights_priority_check CHECK (
    priority = ANY (ARRAY['low','medium','high','critical'])
  ),
  CONSTRAINT ai_insights_status_check CHECK (
    status = ANY (ARRAY['active','acknowledged','resolved','dismissed'])
  ),
  CONSTRAINT ai_insights_confidence_check CHECK (
    confidence_score BETWEEN 0 AND 100 OR confidence_score IS NULL
  )
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_ai_insights_org ON public.ai_insights USING btree (organization_id);
CREATE INDEX IF NOT EXISTS idx_ai_insights_account ON public.ai_insights USING btree (account_id)
  WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_insights_active ON public.ai_insights USING btree (organization_id, priority, created_at DESC)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_ai_insights_type ON public.ai_insights USING btree (organization_id, insight_type, status);

DROP TRIGGER IF EXISTS update_ai_insights_updated_at ON public.ai_insights;
CREATE TRIGGER update_ai_insights_updated_at
  BEFORE UPDATE ON public.ai_insights
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.ai_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_insights_org_isolation" ON public.ai_insights;
CREATE POLICY "ai_insights_org_isolation"
ON public.ai_insights FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

-- ------------------------------------------------------------
-- 4.2 playbooks — Plans d'action SaaS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.playbooks (
  id                    UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL,
  segment_id            UUID NULL REFERENCES public.account_segments(id) ON DELETE SET NULL,
  insight_id            UUID NULL REFERENCES public.ai_insights(id) ON DELETE SET NULL,
  created_by            UUID NULL REFERENCES public.profiles_(id) ON DELETE SET NULL,

  title                 TEXT NOT NULL,
  description           TEXT NULL,
  playbook_type         TEXT NOT NULL DEFAULT 'manual',
  template_category     TEXT NULL,
  actions               JSONB NOT NULL,
  trigger_conditions    JSONB NULL,
  eligibility_criteria  JSONB NULL,

  status                TEXT NOT NULL DEFAULT 'draft',
  priority              TEXT NOT NULL DEFAULT 'medium',
  source                TEXT NOT NULL DEFAULT 'manual',

  -- KPIs d'exécution
  accounts_eligible     INTEGER NULL DEFAULT 0,
  accounts_targeted     INTEGER NULL DEFAULT 0,
  accounts_reached      INTEGER NULL DEFAULT 0,
  accounts_converted    INTEGER NULL DEFAULT 0,
  mrr_recovered_cents   INTEGER NULL DEFAULT 0,
  mrr_expanded_cents    INTEGER NULL DEFAULT 0,

  -- Automation
  is_automated          BOOLEAN NOT NULL DEFAULT FALSE,
  automation_trigger    TEXT NULL,
  execution_frequency   TEXT NULL,
  next_scheduled_at     TIMESTAMPTZ NULL,
  last_executed_at      TIMESTAMPTZ NULL,
  execution_count       INTEGER NOT NULL DEFAULT 0,

  requires_approval     BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by           UUID NULL REFERENCES public.profiles_(id) ON DELETE SET NULL,
  approved_at           TIMESTAMPTZ NULL,

  is_template           BOOLEAN NOT NULL DEFAULT FALSE,
  confidence_score      NUMERIC(5,2) NULL,
  ai_model_version      TEXT NULL,

  activated_at          TIMESTAMPTZ NULL,
  completed_at          TIMESTAMPTZ NULL,
  deactivated_at        TIMESTAMPTZ NULL,
  deactivation_reason   TEXT NULL,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT playbooks_pkey PRIMARY KEY (id),
  CONSTRAINT playbooks_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT playbooks_playbook_type_check CHECK (
    playbook_type = ANY (ARRAY['manual','automated','semi_automated','template'])
  ),
  CONSTRAINT playbooks_status_check CHECK (
    status = ANY (ARRAY['draft','active','paused','completed','archived'])
  ),
  CONSTRAINT playbooks_priority_check CHECK (
    priority = ANY (ARRAY['low','medium','high','critical'])
  ),
  CONSTRAINT playbooks_template_category_check CHECK (
    template_category = ANY (ARRAY[
      'churn_prevention','expansion','onboarding','reactivation','renewal','winback'
    ]) OR template_category IS NULL
  ),
  CONSTRAINT playbooks_activation_coherence_check CHECK (
    (status = 'active' AND activated_at IS NOT NULL) OR status <> 'active'
  ),
  CONSTRAINT playbooks_approval_coherence_check CHECK (
    (requires_approval = FALSE)
    OR (requires_approval = TRUE AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR (requires_approval = TRUE AND status = 'draft')
  ),
  CONSTRAINT playbooks_funnel_coherence_check CHECK (
    COALESCE(accounts_eligible, 0) >= COALESCE(accounts_targeted, 0)
    AND COALESCE(accounts_targeted, 0) >= COALESCE(accounts_reached, 0)
    AND COALESCE(accounts_reached, 0) >= COALESCE(accounts_converted, 0)
  )
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_playbooks_org_status ON public.playbooks USING btree (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_playbooks_segment ON public.playbooks USING btree (segment_id)
  WHERE segment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_playbooks_automated ON public.playbooks USING btree (organization_id, next_scheduled_at)
  WHERE is_automated = TRUE AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_playbooks_templates ON public.playbooks USING btree (template_category, created_at DESC)
  WHERE is_template = TRUE;
CREATE INDEX IF NOT EXISTS idx_playbooks_actions ON public.playbooks USING gin (actions);

DROP TRIGGER IF EXISTS update_playbooks_updated_at ON public.playbooks;
CREATE TRIGGER update_playbooks_updated_at
  BEFORE UPDATE ON public.playbooks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.playbooks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "playbooks_org_isolation" ON public.playbooks;
CREATE POLICY "playbooks_org_isolation"
ON public.playbooks FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

-- ------------------------------------------------------------
-- 4.3 playbook_executions — Historique d'exécution des playbooks
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.playbook_executions (
  id                UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL,
  playbook_id       UUID NOT NULL,
  account_id        UUID NOT NULL,
  segment_id        UUID NULL REFERENCES public.account_segments(id) ON DELETE SET NULL,
  triggered_by      UUID NULL REFERENCES public.profiles_(id) ON DELETE SET NULL,

  execution_status  TEXT NOT NULL DEFAULT 'pending',
  execution_source  TEXT NOT NULL DEFAULT 'manual',
  actions_completed JSONB NULL,
  steps_timeline    JSONB NULL,
  total_steps       INTEGER NULL,
  completed_steps   INTEGER NULL DEFAULT 0,
  failed_steps      INTEGER NULL DEFAULT 0,

  -- Résultat
  account_responded    BOOLEAN NULL DEFAULT FALSE,
  account_converted    BOOLEAN NULL DEFAULT FALSE,
  conversion_type      TEXT NULL,
  conversion_value_cents INTEGER NULL,
  converted_at         TIMESTAMPTZ NULL,

  -- Scores avant/après
  health_score_before  NUMERIC(5,2) NULL,
  health_score_after   NUMERIC(5,2) NULL,
  churn_risk_before    NUMERIC(5,2) NULL,
  churn_risk_after     NUMERIC(5,2) NULL,

  -- Slack
  slack_notification_sent    BOOLEAN NULL DEFAULT FALSE,
  slack_notification_sent_at TIMESTAMPTZ NULL,
  slack_channel              TEXT NULL,
  slack_message_ts           TEXT NULL,

  -- Erreurs & retry
  error_count       INTEGER NULL DEFAULT 0,
  last_error        TEXT NULL,
  retry_count       INTEGER NULL DEFAULT 0,
  max_retries       INTEGER NULL DEFAULT 3,
  next_retry_at     TIMESTAMPTZ NULL,
  is_retryable      BOOLEAN NULL DEFAULT TRUE,

  cancelled_at        TIMESTAMPTZ NULL,
  cancellation_reason TEXT NULL,
  cancelled_by        UUID NULL REFERENCES public.profiles_(id) ON DELETE SET NULL,

  executed_at   TIMESTAMPTZ NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ NULL,
  completed_at  TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT playbook_executions_pkey PRIMARY KEY (id),
  CONSTRAINT playbook_executions_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT playbook_executions_playbook_id_fkey FOREIGN KEY (playbook_id)
    REFERENCES public.playbooks(id) ON DELETE CASCADE,
  CONSTRAINT playbook_executions_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  CONSTRAINT playbook_executions_status_check CHECK (
    execution_status = ANY (ARRAY['pending','running','completed','failed','cancelled','partially_completed'])
  ),
  CONSTRAINT playbook_executions_source_check CHECK (
    execution_source = ANY (ARRAY['manual','scheduled','threshold_triggered','insight_triggered'])
  ),
  CONSTRAINT playbook_executions_conversion_type_check CHECK (
    conversion_type = ANY (ARRAY['renewal','expansion','reactivation','none']) OR conversion_type IS NULL
  ),
  CONSTRAINT playbook_executions_conversion_coherence_check CHECK (
    (account_converted = FALSE AND converted_at IS NULL)
    OR account_converted = TRUE
  ),
  CONSTRAINT playbook_executions_health_check CHECK (
    (health_score_before BETWEEN 0 AND 100 OR health_score_before IS NULL)
    AND (health_score_after BETWEEN 0 AND 100 OR health_score_after IS NULL)
  ),
  CONSTRAINT playbook_executions_steps_coherence_check CHECK (
    total_steps IS NULL
    OR (COALESCE(completed_steps, 0) + COALESCE(failed_steps, 0)) <= total_steps
  )
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_pe_org ON public.playbook_executions USING btree (organization_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pe_playbook ON public.playbook_executions USING btree (playbook_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pe_account ON public.playbook_executions USING btree (account_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pe_status ON public.playbook_executions USING btree (organization_id, execution_status, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pe_pending ON public.playbook_executions USING btree (execution_status, executed_at)
  WHERE execution_status IN ('pending','running');
CREATE INDEX IF NOT EXISTS idx_pe_retry ON public.playbook_executions USING btree (next_retry_at)
  WHERE is_retryable = TRUE AND retry_count < max_retries;
CREATE INDEX IF NOT EXISTS idx_pe_converted ON public.playbook_executions USING btree (organization_id, converted_at DESC)
  WHERE account_converted = TRUE;

DROP TRIGGER IF EXISTS update_playbook_executions_updated_at ON public.playbook_executions;
CREATE TRIGGER update_playbook_executions_updated_at
  BEFORE UPDATE ON public.playbook_executions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.playbook_executions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "playbook_executions_org_isolation" ON public.playbook_executions;
CREATE POLICY "playbook_executions_org_isolation"
ON public.playbook_executions FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);
