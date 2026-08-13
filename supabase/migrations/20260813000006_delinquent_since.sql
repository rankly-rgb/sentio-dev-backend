-- Lot 5 (2026-08-13, #35) — accounts.delinquent_since
--
-- Complément à l'audit délinquence du 2026-08-06 : is_delinquent est un
-- booléen plat, sans horodatage compagnon — un impayé du jour et un impayé
-- de 40 jours scorent identiquement (35pts, payment_delinquent). Ce
-- chantier ajoute la durée comme axe d'escalade (voir CLAUDE.md, grille de
-- plancher de bande).
--
-- NULL par défaut, jamais now() : un compte délinquent sans date connue
-- (transition passée non observée, ou source de date indisponible au
-- moment du calcul) reste NULL — "durée inconnue", jamais "délinquent
-- depuis aujourd'hui" (S1, no data ≠ neutral data).

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS delinquent_since DATE NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_delinquent_since
  ON public.accounts (organization_id, delinquent_since)
  WHERE delinquent_since IS NOT NULL;

-- Plancher de bande par durée (applyDelinquencyBandFloor, _shared/scoring.ts,
-- model_version 'v3.1') : un compte délinquent depuis >= 45 jours est
-- désormais planché à churn_risk_band='critical', un tier au-dessus de
-- 'high' — jamais atteint par les signaux additifs seuls avant ce lot.
-- Élargit les CHECK constraints posées par 20260803000001_churn_risk_band_
-- churned_state.sql ('low'/'watch'/'high'/'churned' -> +'critical'). Sans ce
-- changement, le premier calculate-scores écrivant 'critical' échouerait
-- pour tout compte délinquent depuis 45 jours ou plus.

ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_churn_risk_band_check;

ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_churn_risk_band_check CHECK (
    churn_risk_band = ANY (ARRAY['low','watch','high','critical','churned']) OR churn_risk_band IS NULL
  );

ALTER TABLE public.score_history
  DROP CONSTRAINT IF EXISTS score_history_churn_risk_band_check;

ALTER TABLE public.score_history
  ADD CONSTRAINT score_history_churn_risk_band_check CHECK (
    churn_risk_band = ANY (ARRAY['low','watch','high','critical','churned']) OR churn_risk_band IS NULL
  );
