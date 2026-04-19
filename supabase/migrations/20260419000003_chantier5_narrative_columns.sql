-- ============================================================
-- Migration : Chantier 5 — Colonnes narratives de score
-- Ajoute 5 colonnes TEXT sur accounts pour les phrases contextuelles
-- générées par calculate-scores. Persistées pour accès direct
-- depuis le client Supabase sans passer par une Edge Function.
-- ============================================================

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS health_narrative     TEXT NULL,
  ADD COLUMN IF NOT EXISTS financial_narrative  TEXT NULL,
  ADD COLUMN IF NOT EXISTS usage_narrative      TEXT NULL,
  ADD COLUMN IF NOT EXISTS engagement_narrative TEXT NULL,
  ADD COLUMN IF NOT EXISTS contract_narrative   TEXT NULL;

COMMENT ON COLUMN public.accounts.health_narrative     IS 'Phrase contextuelle déterministe générée par calculate-scores. Mise à jour à chaque scoring.';
COMMENT ON COLUMN public.accounts.financial_narrative  IS 'Phrase contextuelle déterministe générée par calculate-scores. Mise à jour à chaque scoring.';
COMMENT ON COLUMN public.accounts.usage_narrative      IS 'Phrase contextuelle déterministe générée par calculate-scores. Mise à jour à chaque scoring.';
COMMENT ON COLUMN public.accounts.engagement_narrative IS 'Phrase contextuelle déterministe générée par calculate-scores. Mise à jour à chaque scoring.';
COMMENT ON COLUMN public.accounts.contract_narrative   IS 'Phrase contextuelle déterministe générée par calculate-scores. Mise à jour à chaque scoring.';
