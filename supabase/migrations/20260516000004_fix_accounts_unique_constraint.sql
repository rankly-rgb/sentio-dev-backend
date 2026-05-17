-- Fix: partial index on accounts(organization_id, stripe_customer_id) breaks PostgREST upsert
-- ON CONFLICT (col1, col2) cannot reference a partial index — it needs a full unique constraint.
-- PostgreSQL UNIQUE naturally allows multiple NULLs (NULL != NULL), so no behavioural change.

DROP INDEX IF EXISTS public.idx_accounts_org_stripe_unique;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounts_org_stripe_unique'
      AND conrelid = 'public.accounts'::regclass
  ) THEN
    ALTER TABLE public.accounts
      ADD CONSTRAINT accounts_org_stripe_unique
      UNIQUE (organization_id, stripe_customer_id);
  END IF;
END;
$$;
