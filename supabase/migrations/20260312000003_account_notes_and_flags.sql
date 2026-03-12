-- Migration: account_notes table + accounts.flags column
-- Supports playbook actions: log_note, flag_for_review

-- ── 1. Add flags JSONB column to accounts ──
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS flags JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN accounts.flags IS 'Internal tags/flags set by playbook actions (e.g. flag_for_review). Array of {flag, set_at, playbook_id}';

-- ── 2. Create account_notes table ──
CREATE TABLE IF NOT EXISTS public.account_notes (
  id                UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL,
  account_id        UUID NOT NULL,

  -- Note content (Zero-PII: only scores, MRR, identifiers — never names/emails)
  note_type         TEXT NOT NULL DEFAULT 'playbook_action',
  title             TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',

  -- Source tracking
  source            TEXT NOT NULL DEFAULT 'playbook',
  playbook_id       UUID NULL,
  execution_id      UUID NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT account_notes_pkey PRIMARY KEY (id),
  CONSTRAINT account_notes_org_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT account_notes_account_fk FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CONSTRAINT account_notes_note_type_check CHECK (note_type IN ('playbook_action', 'manual', 'system'))
);

-- ── 3. RLS ──
ALTER TABLE account_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON account_notes
  FOR ALL
  USING (organization_id = (SELECT user_organization_id()))
  WITH CHECK (organization_id = (SELECT user_organization_id()));

-- ── 4. Indexes ──
CREATE INDEX IF NOT EXISTS idx_account_notes_account ON account_notes (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_notes_org ON account_notes (organization_id);

-- ── 5. Updated_at trigger ──
CREATE TRIGGER update_account_notes_updated_at
  BEFORE UPDATE ON account_notes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ── 6. GIN index on accounts.flags for JSONB queries ──
CREATE INDEX IF NOT EXISTS idx_accounts_flags ON accounts USING GIN (flags);
