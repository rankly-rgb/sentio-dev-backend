-- Scoring Engine V2 (produit) — model_version 'v3' en base.
--
-- 'v3' réutilise la colonne score_history.model_version déjà posée par
-- 20260712000002_score_history_versioning.sql (pas de nouvelle colonne
-- scoring_model_version — la dupliquer aurait été une deuxième source de
-- vérité pour la même information). L'ancien modèle Stripe+HubSpot+usage
-- portait déjà la valeur 'v2-explicit-no-data' ; ce nouveau modèle
-- Stripe-only à 3 dimensions (payment_health/revenue_dynamics/contract_renewal)
-- prend 'v3' pour ne pas polluer les courbes historiques avec un changement
-- de sémantique silencieux (health_score n'est plus jamais une valeur
-- toujours-numérique — voir health_score_status ci-dessous).
--
-- Toutes les colonnes sont additives et nullables : les lignes historiques
-- (model_version='v2-explicit-no-data' et antérieures) ne sont pas
-- rétro-remplies.

-- ------------------------------------------------------------
-- 1. Nouvelles dimensions v3 (remplacent product_usage/financial/engagement/
--    contract dans le calcul composite, mais ces anciennes colonnes ne sont
--    PAS supprimées — elles restent lisibles comme dernier snapshot v2 pour
--    compat descendante frontend le temps de la migration du contrat API).
-- ------------------------------------------------------------
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS payment_health_score    NUMERIC(5,2) NULL,
  ADD COLUMN IF NOT EXISTS revenue_dynamics_score   NUMERIC(5,2) NULL,
  ADD COLUMN IF NOT EXISTS contract_renewal_score   NUMERIC(5,2) NULL,
  ADD COLUMN IF NOT EXISTS health_score_status      TEXT NULL,
  ADD COLUMN IF NOT EXISTS health_score_max_points  NUMERIC(5,2) NULL,
  ADD COLUMN IF NOT EXISTS health_score_band        TEXT NULL,
  ADD COLUMN IF NOT EXISTS churn_risk_band          TEXT NULL,
  ADD COLUMN IF NOT EXISTS risk_signals_triggered   JSONB NULL,
  ADD COLUMN IF NOT EXISTS risk_signals_evaluated   INTEGER NULL,
  ADD COLUMN IF NOT EXISTS expansion_score_status   TEXT NULL,
  ADD COLUMN IF NOT EXISTS expansion_unavailable_reason TEXT NULL,
  -- S8 : décomposition par dimension (score/statut/poids/signaux sources) —
  -- base de l'explicabilité frontend et du futur résumé en langage naturel.
  ADD COLUMN IF NOT EXISTS score_breakdown          JSONB NULL,
  -- S8 : tendance 30j, calculée et persistée au moment du scoring (pas à la
  -- lecture) via le snapshot score_history disponible le plus proche de J-30.
  ADD COLUMN IF NOT EXISTS trend_30d                TEXT NULL,
  -- Cooldown alerte churn (S9) : dernière alerte envoyée pour ce compte et
  -- signaux qui l'ont déclenchée, pour détecter un nouveau signal CRITIQUE
  -- qui doit bypasser le cooldown de 14 jours.
  ADD COLUMN IF NOT EXISTS last_churn_alert_at      TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_alert_signals       JSONB NULL;

ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_payment_health_score_check,
  DROP CONSTRAINT IF EXISTS accounts_revenue_dynamics_score_check,
  DROP CONSTRAINT IF EXISTS accounts_contract_renewal_score_check,
  DROP CONSTRAINT IF EXISTS accounts_health_score_status_check,
  DROP CONSTRAINT IF EXISTS accounts_health_score_band_check,
  DROP CONSTRAINT IF EXISTS accounts_churn_risk_band_check,
  DROP CONSTRAINT IF EXISTS accounts_expansion_score_status_check,
  DROP CONSTRAINT IF EXISTS accounts_trend_30d_check;

ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_payment_health_score_check CHECK (
    payment_health_score BETWEEN 0 AND 100 OR payment_health_score IS NULL
  ),
  ADD CONSTRAINT accounts_revenue_dynamics_score_check CHECK (
    revenue_dynamics_score BETWEEN 0 AND 100 OR revenue_dynamics_score IS NULL
  ),
  ADD CONSTRAINT accounts_contract_renewal_score_check CHECK (
    contract_renewal_score BETWEEN 0 AND 100 OR contract_renewal_score IS NULL
  ),
  ADD CONSTRAINT accounts_health_score_status_check CHECK (
    health_score_status = ANY (ARRAY['complete','partial','insufficient']) OR health_score_status IS NULL
  ),
  ADD CONSTRAINT accounts_health_score_band_check CHECK (
    health_score_band = ANY (ARRAY['healthy','watch','at_risk']) OR health_score_band IS NULL
  ),
  ADD CONSTRAINT accounts_churn_risk_band_check CHECK (
    churn_risk_band = ANY (ARRAY['low','watch','high']) OR churn_risk_band IS NULL
  ),
  ADD CONSTRAINT accounts_expansion_score_status_check CHECK (
    expansion_score_status = ANY (ARRAY['available','unavailable']) OR expansion_score_status IS NULL
  ),
  ADD CONSTRAINT accounts_trend_30d_check CHECK (
    trend_30d = ANY (ARRAY['up','flat','down']) OR trend_30d IS NULL
  );

-- Même jeu de colonnes sur score_history (snapshot quotidien immuable).
ALTER TABLE public.score_history
  ADD COLUMN IF NOT EXISTS payment_health_score    NUMERIC(5,2) NULL,
  ADD COLUMN IF NOT EXISTS revenue_dynamics_score   NUMERIC(5,2) NULL,
  ADD COLUMN IF NOT EXISTS contract_renewal_score   NUMERIC(5,2) NULL,
  ADD COLUMN IF NOT EXISTS health_score_status      TEXT NULL,
  ADD COLUMN IF NOT EXISTS health_score_max_points  NUMERIC(5,2) NULL,
  ADD COLUMN IF NOT EXISTS health_score_band        TEXT NULL,
  ADD COLUMN IF NOT EXISTS churn_risk_band          TEXT NULL,
  ADD COLUMN IF NOT EXISTS risk_signals_triggered   JSONB NULL,
  ADD COLUMN IF NOT EXISTS risk_signals_evaluated   INTEGER NULL,
  ADD COLUMN IF NOT EXISTS expansion_score_status   TEXT NULL,
  ADD COLUMN IF NOT EXISTS expansion_unavailable_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS score_breakdown          JSONB NULL,
  ADD COLUMN IF NOT EXISTS trend_30d                TEXT NULL;

ALTER TABLE public.score_history
  DROP CONSTRAINT IF EXISTS score_history_payment_health_score_check,
  DROP CONSTRAINT IF EXISTS score_history_revenue_dynamics_score_check,
  DROP CONSTRAINT IF EXISTS score_history_contract_renewal_score_check,
  DROP CONSTRAINT IF EXISTS score_history_health_score_status_check,
  DROP CONSTRAINT IF EXISTS score_history_health_score_band_check,
  DROP CONSTRAINT IF EXISTS score_history_churn_risk_band_check,
  DROP CONSTRAINT IF EXISTS score_history_expansion_score_status_check,
  DROP CONSTRAINT IF EXISTS score_history_trend_30d_check;

ALTER TABLE public.score_history
  ADD CONSTRAINT score_history_payment_health_score_check CHECK (
    payment_health_score BETWEEN 0 AND 100 OR payment_health_score IS NULL
  ),
  ADD CONSTRAINT score_history_revenue_dynamics_score_check CHECK (
    revenue_dynamics_score BETWEEN 0 AND 100 OR revenue_dynamics_score IS NULL
  ),
  ADD CONSTRAINT score_history_contract_renewal_score_check CHECK (
    contract_renewal_score BETWEEN 0 AND 100 OR contract_renewal_score IS NULL
  ),
  ADD CONSTRAINT score_history_health_score_status_check CHECK (
    health_score_status = ANY (ARRAY['complete','partial','insufficient']) OR health_score_status IS NULL
  ),
  ADD CONSTRAINT score_history_health_score_band_check CHECK (
    health_score_band = ANY (ARRAY['healthy','watch','at_risk']) OR health_score_band IS NULL
  ),
  ADD CONSTRAINT score_history_trend_30d_check CHECK (
    trend_30d = ANY (ARRAY['up','flat','down']) OR trend_30d IS NULL
  ),
  ADD CONSTRAINT score_history_churn_risk_band_check CHECK (
    churn_risk_band = ANY (ARRAY['low','watch','high']) OR churn_risk_band IS NULL
  ),
  ADD CONSTRAINT score_history_expansion_score_status_check CHECK (
    expansion_score_status = ANY (ARRAY['available','unavailable']) OR expansion_score_status IS NULL
  );

-- ------------------------------------------------------------
-- 2. Poids configurables par org (S11) — défaut = poids v3 produit.
--    Pas de renormalisation automatique : somme stricte à 100, chaque poids
--    entre 10 et 60, sinon la contrainte rejette l'update (pas de fallback
--    silencieux — cohérent avec la décision d'architecture "pas de
--    renormalisation dynamique" actée pour health_score).
-- ------------------------------------------------------------
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS scoring_weights JSONB NOT NULL DEFAULT
    '{"payment_health": 35, "revenue_dynamics": 35, "contract_renewal": 30}'::jsonb;

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_scoring_weights_check;

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_scoring_weights_check CHECK (
    (scoring_weights ? 'payment_health')
    AND (scoring_weights ? 'revenue_dynamics')
    AND (scoring_weights ? 'contract_renewal')
    AND ((scoring_weights->>'payment_health')::int BETWEEN 10 AND 60)
    AND ((scoring_weights->>'revenue_dynamics')::int BETWEEN 10 AND 60)
    AND ((scoring_weights->>'contract_renewal')::int BETWEEN 10 AND 60)
    AND (
      (scoring_weights->>'payment_health')::int
      + (scoring_weights->>'revenue_dynamics')::int
      + (scoring_weights->>'contract_renewal')::int
      = 100
    )
  );

-- ------------------------------------------------------------
-- 3. Segment "Données insuffisantes" (S12) — nouveau segment système.
--    ALTER ... DROP CONSTRAINT + ADD CONSTRAINT uniquement (aucun DROP de
--    colonne ni de table).
-- ------------------------------------------------------------
ALTER TABLE public.account_segments
  DROP CONSTRAINT IF EXISTS account_segments_segment_type_check;

ALTER TABLE public.account_segments
  ADD CONSTRAINT account_segments_segment_type_check CHECK (
    segment_type = ANY (ARRAY[
      'champions','en_expansion','stables','a_risque_leger',
      'en_danger_critique','impayes','en_churn','nouveaux',
      'donnees_insuffisantes'
    ])
  );

-- ------------------------------------------------------------
-- 4. confidence_score — dépréciation (S5 : remplacé par severity +
--    risk_signals_triggered, règles déterministes et non probabilistes).
--    Colonne conservée (aucun DROP), plus jamais peuplée à partir de ce
--    changement. Le frontend retire l'affichage correspondant (voir
--    docs/API_CONTRACTS.md).
-- ------------------------------------------------------------
COMMENT ON COLUMN public.segment_memberships.confidence_score IS
  'DEPRECATED (2026-07-25, Scoring Engine V2) : ne plus peupler. Les scores étant déterministes (règles Stripe), un pourcentage de confiance est une fausse précision. Remplacé par accounts.risk_signals_triggered (severity + libellé par signal). Conservé pour compat descendante, toujours NULL sur les nouvelles lignes.';
