-- ============================================================
-- Migration : workflow_steps
-- Ajout du support Workflows multi-etapes + email tracking
-- Colonnes : steps JSONB, is_workflow, current_step, etc.
-- Table : email_send_log (audit trail Resend)
-- ============================================================

-- 1. Ajouter steps JSONB et is_workflow a playbooks
ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS steps JSONB NULL;
ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS is_workflow BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Etendre template_category CHECK (ajouter 7 nouvelles categories)
ALTER TABLE playbooks DROP CONSTRAINT IF EXISTS playbooks_template_category_check;
ALTER TABLE playbooks ADD CONSTRAINT playbooks_template_category_check CHECK (
  template_category = ANY (ARRAY[
    'churn_prevention', 'expansion', 'onboarding', 'reactivation', 'renewal', 'winback',
    'payment_recovery', 'health_monitoring', 'customer_education', 'nps_detractors',
    'champions_advocacy', 'downgrade_prevention', 'success_planning'
  ]) OR template_category IS NULL
);

-- 3. Ajouter colonnes workflow tracking a playbook_executions
ALTER TABLE playbook_executions ADD COLUMN IF NOT EXISTS current_step INTEGER NULL DEFAULT 1;
ALTER TABLE playbook_executions ADD COLUMN IF NOT EXISTS next_step_due_at TIMESTAMPTZ NULL;
ALTER TABLE playbook_executions ADD COLUMN IF NOT EXISTS workflow_completed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE playbook_executions ADD COLUMN IF NOT EXISTS emails_sent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE playbook_executions ADD COLUMN IF NOT EXISTS last_email_sent_at TIMESTAMPTZ NULL;
ALTER TABLE playbook_executions ADD COLUMN IF NOT EXISTS email_delivery_log JSONB NULL;

-- 4. Index pour le workflow scheduler (executions avec steps en attente)
CREATE INDEX IF NOT EXISTS idx_pe_workflow_pending
  ON playbook_executions (next_step_due_at, execution_status)
  WHERE workflow_completed = FALSE AND execution_status = 'running';

-- 5. Index pour filtrer playbooks par is_workflow
CREATE INDEX IF NOT EXISTS idx_playbooks_workflow
  ON playbooks (organization_id, is_workflow, status, created_at DESC);

-- 6. Table email_send_log (audit trail des envois Resend)
CREATE TABLE IF NOT EXISTS public.email_send_log (
  id                UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL,
  execution_id      UUID NULL REFERENCES public.playbook_executions(id) ON DELETE SET NULL,
  account_id        UUID NULL REFERENCES public.accounts(id) ON DELETE SET NULL,
  playbook_id       UUID NULL REFERENCES public.playbooks(id) ON DELETE SET NULL,

  resend_message_id TEXT NULL,
  email_to          TEXT NOT NULL,
  email_subject     TEXT NOT NULL,
  email_status      TEXT NOT NULL DEFAULT 'sent',
  step_order        INTEGER NULL,

  sent_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at      TIMESTAMPTZ NULL,
  error_message     TEXT NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT email_send_log_pkey PRIMARY KEY (id),
  CONSTRAINT email_send_log_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT email_send_log_status_check CHECK (
    email_status = ANY(ARRAY['pending', 'sent', 'delivered', 'bounced', 'failed'])
  )
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_email_log_org ON public.email_send_log USING btree (organization_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_log_execution ON public.email_send_log USING btree (execution_id);

ALTER TABLE public.email_send_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "email_send_log_org_isolation"
ON public.email_send_log FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);
