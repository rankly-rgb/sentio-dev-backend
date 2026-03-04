-- ============================================================
-- Migration : Ajouter les 3 sous-scores manquants
-- Tables : accounts, score_history
-- Colonnes : financial_score, engagement_score, contract_score
-- ============================================================

-- ── accounts ────────────────────────────────────────────────
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS financial_score   NUMERIC(5,2) NULL,
  ADD COLUMN IF NOT EXISTS engagement_score  NUMERIC(5,2) NULL,
  ADD COLUMN IF NOT EXISTS contract_score    NUMERIC(5,2) NULL;

ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_financial_score_check CHECK (
    financial_score BETWEEN 0 AND 100 OR financial_score IS NULL
  ),
  ADD CONSTRAINT accounts_engagement_score_check CHECK (
    engagement_score BETWEEN 0 AND 100 OR engagement_score IS NULL
  ),
  ADD CONSTRAINT accounts_contract_score_check CHECK (
    contract_score BETWEEN 0 AND 100 OR contract_score IS NULL
  );

-- ── score_history ───────────────────────────────────────────
ALTER TABLE public.score_history
  ADD COLUMN IF NOT EXISTS financial_score   NUMERIC(5,2) NULL,
  ADD COLUMN IF NOT EXISTS engagement_score  NUMERIC(5,2) NULL,
  ADD COLUMN IF NOT EXISTS contract_score    NUMERIC(5,2) NULL;

ALTER TABLE public.score_history
  ADD CONSTRAINT score_history_financial_check CHECK (
    financial_score BETWEEN 0 AND 100 OR financial_score IS NULL
  ),
  ADD CONSTRAINT score_history_engagement_check CHECK (
    engagement_score BETWEEN 0 AND 100 OR engagement_score IS NULL
  ),
  ADD CONSTRAINT score_history_contract_check CHECK (
    contract_score BETWEEN 0 AND 100 OR contract_score IS NULL
  );
