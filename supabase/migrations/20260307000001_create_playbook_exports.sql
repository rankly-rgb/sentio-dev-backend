-- Migration: playbook_exports table
-- Export tracking for playbook account exports (CSV/JSON)

-- ============================================================================
-- Table: playbook_exports
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.playbook_exports (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         UUID NOT NULL,
  playbook_id             UUID NULL,
  exported_by_profile_id  UUID NULL,
  exported_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  account_count           INTEGER NOT NULL DEFAULT 0,
  mrr_at_risk_cents       INTEGER NOT NULL DEFAULT 0,
  filters_applied         JSONB NOT NULL DEFAULT '{}',
  format                  TEXT NOT NULL DEFAULT 'csv',

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT playbook_exports_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT playbook_exports_playbook_id_fkey
    FOREIGN KEY (playbook_id) REFERENCES public.playbooks(id) ON DELETE SET NULL,
  CONSTRAINT playbook_exports_exported_by_fkey
    FOREIGN KEY (exported_by_profile_id) REFERENCES public.profiles_(id) ON DELETE SET NULL,
  CONSTRAINT playbook_exports_format_check
    CHECK (format IN ('csv', 'json')),
  CONSTRAINT playbook_exports_account_count_check
    CHECK (account_count >= 0),
  CONSTRAINT playbook_exports_mrr_at_risk_check
    CHECK (mrr_at_risk_cents >= 0)
) TABLESPACE pg_default;

-- Index on organization_id (standard pattern)
CREATE INDEX IF NOT EXISTS idx_playbook_exports_org
  ON public.playbook_exports (organization_id, exported_at DESC);

-- Idempotency: unique per org + playbook + filters + minute window
-- Prevents duplicate exports within the same minute
CREATE UNIQUE INDEX IF NOT EXISTS idx_playbook_exports_idempotent
  ON public.playbook_exports (
    organization_id,
    playbook_id,
    format,
    filters_applied,
    date_trunc('minute', exported_at)
  );

-- ============================================================================
-- RLS: org_isolation (standard pattern)
-- ============================================================================

ALTER TABLE public.playbook_exports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "playbook_exports_org_isolation" ON public.playbook_exports;
CREATE POLICY "playbook_exports_org_isolation"
ON public.playbook_exports FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

-- ============================================================================
-- Trigger: update_updated_at_column (standard pattern)
-- ============================================================================

DROP TRIGGER IF EXISTS update_playbook_exports_updated_at ON public.playbook_exports;
CREATE TRIGGER update_playbook_exports_updated_at
  BEFORE UPDATE ON public.playbook_exports
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
