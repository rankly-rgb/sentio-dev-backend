-- ============================================================
-- Migration : Fix duplicate accounts + reinforce uniqueness
-- 1. Reassign FK references from duplicate accounts to the survivor (oldest)
-- 2. Delete duplicate account rows (CASCADE cleans up remaining children)
-- 3. Ensure UNIQUE(organization_id, stripe_customer_id) on accounts
-- 4. Clean up duplicate ai_insights per (org, account, type, day)
-- 5. Replace partial ai_insights dedup index with a full functional unique index
--
-- Idempotent: safe to run multiple times.
-- Never uses DROP TABLE / DROP COLUMN / DROP CONSTRAINT on live data.
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- STEP 1 — Reassign FK refs from duplicate accounts to survivors
--
-- "Survivor" = oldest row by created_at, tie-break by id ASC.
-- For tables with UNIQUE constraints on (organization_id, account_id)
-- or (segment_id, account_id), we delete the duplicate's conflicting
-- child rows first so the UPDATE can proceed without violation.
-- ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT 1
    FROM public.accounts
    GROUP BY organization_id, stripe_customer_id
    HAVING COUNT(*) > 1
  ) t;

  IF dup_count = 0 THEN
    RAISE NOTICE 'No duplicate accounts found — skipping cleanup.';
    RETURN;
  END IF;

  RAISE NOTICE 'Found % duplicate (org, stripe_customer_id) groups — starting cleanup.', dup_count;

  -- ── 1a. Tables without account-level unique constraints: plain UPDATE ──

  -- subscriptions (UNIQUE: stripe_sub_id — no conflict on account_id)
  UPDATE public.subscriptions s
  SET account_id = survivors.keep_id
  FROM (
    SELECT DISTINCT ON (organization_id, stripe_customer_id)
      id AS keep_id, organization_id, stripe_customer_id
    FROM public.accounts
    ORDER BY organization_id, stripe_customer_id, created_at ASC, id ASC
  ) AS survivors
  JOIN public.accounts dup
    ON dup.organization_id = survivors.organization_id
   AND dup.stripe_customer_id = survivors.stripe_customer_id
   AND dup.id != survivors.keep_id
  WHERE s.account_id = dup.id
    AND s.organization_id = survivors.organization_id;

  -- invoices (UNIQUE: stripe_invoice_id — no conflict on account_id)
  UPDATE public.invoices i
  SET account_id = survivors.keep_id
  FROM (
    SELECT DISTINCT ON (organization_id, stripe_customer_id)
      id AS keep_id, organization_id, stripe_customer_id
    FROM public.accounts
    ORDER BY organization_id, stripe_customer_id, created_at ASC, id ASC
  ) AS survivors
  JOIN public.accounts dup
    ON dup.organization_id = survivors.organization_id
   AND dup.stripe_customer_id = survivors.stripe_customer_id
   AND dup.id != survivors.keep_id
  WHERE i.account_id = dup.id
    AND i.organization_id = survivors.organization_id;

  -- mrr_movements (UNIQUE: stripe_event_id NULLS NOT DISTINCT — no conflict on account_id)
  UPDATE public.mrr_movements m
  SET account_id = survivors.keep_id
  FROM (
    SELECT DISTINCT ON (organization_id, stripe_customer_id)
      id AS keep_id, organization_id, stripe_customer_id
    FROM public.accounts
    ORDER BY organization_id, stripe_customer_id, created_at ASC, id ASC
  ) AS survivors
  JOIN public.accounts dup
    ON dup.organization_id = survivors.organization_id
   AND dup.stripe_customer_id = survivors.stripe_customer_id
   AND dup.id != survivors.keep_id
  WHERE m.account_id = dup.id
    AND m.organization_id = survivors.organization_id;

  -- usage_events (no unique constraint on account_id)
  UPDATE public.usage_events u
  SET account_id = survivors.keep_id
  FROM (
    SELECT DISTINCT ON (organization_id, stripe_customer_id)
      id AS keep_id, organization_id, stripe_customer_id
    FROM public.accounts
    ORDER BY organization_id, stripe_customer_id, created_at ASC, id ASC
  ) AS survivors
  JOIN public.accounts dup
    ON dup.organization_id = survivors.organization_id
   AND dup.stripe_customer_id = survivors.stripe_customer_id
   AND dup.id != survivors.keep_id
  WHERE u.account_id = dup.id
    AND u.organization_id = survivors.organization_id;

  -- ai_insights (no table-level unique on account_id; partial index won't block UPDATE)
  UPDATE public.ai_insights ai
  SET account_id = survivors.keep_id
  FROM (
    SELECT DISTINCT ON (organization_id, stripe_customer_id)
      id AS keep_id, organization_id, stripe_customer_id
    FROM public.accounts
    ORDER BY organization_id, stripe_customer_id, created_at ASC, id ASC
  ) AS survivors
  JOIN public.accounts dup
    ON dup.organization_id = survivors.organization_id
   AND dup.stripe_customer_id = survivors.stripe_customer_id
   AND dup.id != survivors.keep_id
  WHERE ai.account_id = dup.id
    AND ai.organization_id = survivors.organization_id;

  -- playbook_executions (no unique on account_id)
  UPDATE public.playbook_executions pe
  SET account_id = survivors.keep_id
  FROM (
    SELECT DISTINCT ON (organization_id, stripe_customer_id)
      id AS keep_id, organization_id, stripe_customer_id
    FROM public.accounts
    ORDER BY organization_id, stripe_customer_id, created_at ASC, id ASC
  ) AS survivors
  JOIN public.accounts dup
    ON dup.organization_id = survivors.organization_id
   AND dup.stripe_customer_id = survivors.stripe_customer_id
   AND dup.id != survivors.keep_id
  WHERE pe.account_id = dup.id
    AND pe.organization_id = survivors.organization_id;

  -- playbook_execution_logs (no unique on account_id)
  UPDATE public.playbook_execution_logs pel
  SET account_id = survivors.keep_id
  FROM (
    SELECT DISTINCT ON (organization_id, stripe_customer_id)
      id AS keep_id, organization_id, stripe_customer_id
    FROM public.accounts
    ORDER BY organization_id, stripe_customer_id, created_at ASC, id ASC
  ) AS survivors
  JOIN public.accounts dup
    ON dup.organization_id = survivors.organization_id
   AND dup.stripe_customer_id = survivors.stripe_customer_id
   AND dup.id != survivors.keep_id
  WHERE pel.account_id = dup.id
    AND pel.organization_id = survivors.organization_id;

  -- playbook_approval_queue (no unique on account_id)
  UPDATE public.playbook_approval_queue paq
  SET account_id = survivors.keep_id
  FROM (
    SELECT DISTINCT ON (organization_id, stripe_customer_id)
      id AS keep_id, organization_id, stripe_customer_id
    FROM public.accounts
    ORDER BY organization_id, stripe_customer_id, created_at ASC, id ASC
  ) AS survivors
  JOIN public.accounts dup
    ON dup.organization_id = survivors.organization_id
   AND dup.stripe_customer_id = survivors.stripe_customer_id
   AND dup.id != survivors.keep_id
  WHERE paq.account_id = dup.id
    AND paq.organization_id = survivors.organization_id;

  -- outbound_webhook_logs (no unique on account_id, if table exists)
  UPDATE public.outbound_webhook_logs owl
  SET account_id = survivors.keep_id
  FROM (
    SELECT DISTINCT ON (organization_id, stripe_customer_id)
      id AS keep_id, organization_id, stripe_customer_id
    FROM public.accounts
    ORDER BY organization_id, stripe_customer_id, created_at ASC, id ASC
  ) AS survivors
  JOIN public.accounts dup
    ON dup.organization_id = survivors.organization_id
   AND dup.stripe_customer_id = survivors.stripe_customer_id
   AND dup.id != survivors.keep_id
  WHERE owl.account_id = dup.id
    AND owl.organization_id = survivors.organization_id;

  -- ── 1b. Tables with UNIQUE constraints involving account_id ──
  -- Strategy: DELETE duplicate's conflicting rows first, then UPDATE the rest.

  -- hubspot_companies: UNIQUE (organization_id, account_id)
  DELETE FROM public.hubspot_companies hc
  USING (
    SELECT DISTINCT ON (organization_id, stripe_customer_id)
      id AS keep_id, organization_id, stripe_customer_id
    FROM public.accounts
    ORDER BY organization_id, stripe_customer_id, created_at ASC, id ASC
  ) AS survivors
  JOIN public.accounts dup
    ON dup.organization_id = survivors.organization_id
   AND dup.stripe_customer_id = survivors.stripe_customer_id
   AND dup.id != survivors.keep_id
  WHERE hc.account_id = dup.id
    AND hc.organization_id = survivors.organization_id
    AND EXISTS (
      SELECT 1 FROM public.hubspot_companies hc2
      WHERE hc2.account_id = survivors.keep_id
        AND hc2.organization_id = survivors.organization_id
    );

  UPDATE public.hubspot_companies hc
  SET account_id = survivors.keep_id
  FROM (
    SELECT DISTINCT ON (organization_id, stripe_customer_id)
      id AS keep_id, organization_id, stripe_customer_id
    FROM public.accounts
    ORDER BY organization_id, stripe_customer_id, created_at ASC, id ASC
  ) AS survivors
  JOIN public.accounts dup
    ON dup.organization_id = survivors.organization_id
   AND dup.stripe_customer_id = survivors.stripe_customer_id
   AND dup.id != survivors.keep_id
  WHERE hc.account_id = dup.id
    AND hc.organization_id = survivors.organization_id;

  -- score_history: UNIQUE (organization_id, account_id, snapshot_date)
  DELETE FROM public.score_history sh
  USING (
    SELECT DISTINCT ON (organization_id, stripe_customer_id)
      id AS keep_id, organization_id, stripe_customer_id
    FROM public.accounts
    ORDER BY organization_id, stripe_customer_id, created_at ASC, id ASC
  ) AS survivors
  JOIN public.accounts dup
    ON dup.organization_id = survivors.organization_id
   AND dup.stripe_customer_id = survivors.stripe_customer_id
   AND dup.id != survivors.keep_id
  WHERE sh.account_id = dup.id
    AND sh.organization_id = survivors.organization_id
    AND EXISTS (
      SELECT 1 FROM public.score_history sh2
      WHERE sh2.account_id = survivors.keep_id
        AND sh2.organization_id = survivors.organization_id
        AND sh2.snapshot_date = sh.snapshot_date
    );

  UPDATE public.score_history sh
  SET account_id = survivors.keep_id
  FROM (
    SELECT DISTINCT ON (organization_id, stripe_customer_id)
      id AS keep_id, organization_id, stripe_customer_id
    FROM public.accounts
    ORDER BY organization_id, stripe_customer_id, created_at ASC, id ASC
  ) AS survivors
  JOIN public.accounts dup
    ON dup.organization_id = survivors.organization_id
   AND dup.stripe_customer_id = survivors.stripe_customer_id
   AND dup.id != survivors.keep_id
  WHERE sh.account_id = dup.id
    AND sh.organization_id = survivors.organization_id;

  -- segment_memberships: UNIQUE (segment_id, account_id)
  DELETE FROM public.segment_memberships sm
  USING (
    SELECT DISTINCT ON (organization_id, stripe_customer_id)
      id AS keep_id, organization_id, stripe_customer_id
    FROM public.accounts
    ORDER BY organization_id, stripe_customer_id, created_at ASC, id ASC
  ) AS survivors
  JOIN public.accounts dup
    ON dup.organization_id = survivors.organization_id
   AND dup.stripe_customer_id = survivors.stripe_customer_id
   AND dup.id != survivors.keep_id
  WHERE sm.account_id = dup.id
    AND sm.organization_id = survivors.organization_id
    AND EXISTS (
      SELECT 1 FROM public.segment_memberships sm2
      WHERE sm2.account_id = survivors.keep_id
        AND sm2.segment_id = sm.segment_id
    );

  UPDATE public.segment_memberships sm
  SET account_id = survivors.keep_id
  FROM (
    SELECT DISTINCT ON (organization_id, stripe_customer_id)
      id AS keep_id, organization_id, stripe_customer_id
    FROM public.accounts
    ORDER BY organization_id, stripe_customer_id, created_at ASC, id ASC
  ) AS survivors
  JOIN public.accounts dup
    ON dup.organization_id = survivors.organization_id
   AND dup.stripe_customer_id = survivors.stripe_customer_id
   AND dup.id != survivors.keep_id
  WHERE sm.account_id = dup.id
    AND sm.organization_id = survivors.organization_id;

  -- ── 1c. Delete duplicate accounts (CASCADE cleans remaining children) ──
  DELETE FROM public.accounts a
  USING (
    SELECT DISTINCT ON (organization_id, stripe_customer_id)
      id AS keep_id, organization_id, stripe_customer_id
    FROM public.accounts
    ORDER BY organization_id, stripe_customer_id, created_at ASC, id ASC
  ) AS survivors
  WHERE a.organization_id = survivors.organization_id
    AND a.stripe_customer_id = survivors.stripe_customer_id
    AND a.id != survivors.keep_id;

  RAISE NOTICE 'Duplicate accounts cleanup complete.';
END;
$$;

-- ──────────────────────────────────────────────────────────────
-- STEP 2 — Ensure full UNIQUE constraint on accounts
--
-- accounts_org_stripe_key   : created by initial migration 003
-- accounts_org_stripe_unique: created by migration 20260516000004
-- Both may exist — that is fine (redundant but harmless).
-- This block is a safety net for environments where neither exists.
-- ──────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.accounts'::regclass
      AND contype = 'u'
      AND conname IN ('accounts_org_stripe_key', 'accounts_org_stripe_unique')
  ) THEN
    ALTER TABLE public.accounts
      ADD CONSTRAINT accounts_org_stripe_unique
      UNIQUE (organization_id, stripe_customer_id);
    RAISE NOTICE 'Added UNIQUE constraint accounts_org_stripe_unique on accounts.';
  ELSE
    RAISE NOTICE 'UNIQUE constraint on accounts(organization_id, stripe_customer_id) already exists — skipping.';
  END IF;
END;
$$;

-- ──────────────────────────────────────────────────────────────
-- STEP 3 — Clean duplicate ai_insights per (org, account, type, day)
--
-- Keeps the oldest insight per group (MIN created_at), removes the rest.
-- Required before adding the functional unique index below.
-- ──────────────────────────────────────────────────────────────
DELETE FROM public.ai_insights
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY organization_id, account_id, insight_type, DATE(created_at)
        ORDER BY created_at ASC, id ASC
      ) AS rn
    FROM public.ai_insights
    WHERE account_id IS NOT NULL
  ) ranked
  WHERE rn > 1
);

-- ──────────────────────────────────────────────────────────────
-- STEP 4 — Full functional unique index on ai_insights
--
-- Replaces the existing partial index (WHERE status = 'active') with a
-- broader constraint: at most one insight per (org, account, type) per
-- calendar day, regardless of status.
--
-- Note: column `detected_at` does not exist in this schema.
--       Using created_at::date (UTC) as the equivalent expression.
--
-- DATE(timestamptz) is STABLE (timezone-sensitive) — PostgreSQL requires
-- IMMUTABLE for index expressions. We wrap the cast in an IMMUTABLE helper
-- that pins the conversion to UTC, making it safe for index use.
--
-- The old partial index idx_ai_insights_active_dedup is kept as-is
-- (for backward compatibility with existing queries that filter status='active');
-- the new index provides full day-level deduplication across all statuses.
-- ──────────────────────────────────────────────────────────────

-- IMMUTABLE helper: convert timestamptz → UTC date for index use
CREATE OR REPLACE FUNCTION public.timestamptz_to_utc_date(ts TIMESTAMPTZ)
RETURNS DATE LANGUAGE SQL IMMUTABLE PARALLEL SAFE
AS $$ SELECT ($1 AT TIME ZONE 'UTC')::date $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_insights_org_account_type_day
  ON public.ai_insights (
    organization_id,
    account_id,
    insight_type,
    public.timestamptz_to_utc_date(created_at)
  )
  WHERE account_id IS NOT NULL;
