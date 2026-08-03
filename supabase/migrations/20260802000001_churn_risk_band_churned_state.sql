-- D1 (2026-08-02) : un compte churné (mrr_cents=0 ou abonnement canceled)
-- reçoit désormais un état figé churn_risk_band='churned' au lieu d'un
-- score calculé sur ses signaux historiques (calculate-scores/index.ts,
-- scoreAccountPure). churn_risk_score reste NULL pour ces comptes (déjà
-- nullable — voir 20260301000003_phase2_core_data.sql) : pas de clamp à 0,
-- un compte parti n'est pas "à risque", il est perdu.
--
-- Élargit les CHECK constraints sur accounts.churn_risk_band et
-- score_history.churn_risk_band ('low'/'watch'/'high' -> +'churned') posées
-- par 20260725000001_scoring_engine_v3.sql. Sans ce changement, le premier
-- run de calculate-scores écrivant 'churned' échouerait sur la contrainte
-- existante pour tout compte à mrr_cents=0 ou abonnement annulé.

ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_churn_risk_band_check;

ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_churn_risk_band_check CHECK (
    churn_risk_band = ANY (ARRAY['low','watch','high','churned']) OR churn_risk_band IS NULL
  );

ALTER TABLE public.score_history
  DROP CONSTRAINT IF EXISTS score_history_churn_risk_band_check;

ALTER TABLE public.score_history
  ADD CONSTRAINT score_history_churn_risk_band_check CHECK (
    churn_risk_band = ANY (ARRAY['low','watch','high','churned']) OR churn_risk_band IS NULL
  );
