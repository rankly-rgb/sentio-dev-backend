-- Migration : peer_benchmarks
-- Stocke les percentiles anonymisés inter-organisations calculés quotidiennement.
-- Pas de RLS : données agrégées globales, aucun org_id.

CREATE TABLE IF NOT EXISTS peer_benchmarks (
  id             UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  computed_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  org_count      INTEGER      NOT NULL CHECK (org_count >= 3),

  -- NRR (Net Revenue Retention) — higher is better
  nrr_p25        NUMERIC(7,2),
  nrr_p50        NUMERIC(7,2),
  nrr_p75        NUMERIC(7,2),

  -- Revenue churn rate annuel — lower is better
  churn_rate_p25 NUMERIC(7,2),
  churn_rate_p50 NUMERIC(7,2),
  churn_rate_p75 NUMERIC(7,2),

  -- Croissance MRR 12 mois — higher is better
  mrr_growth_p25 NUMERIC(7,2),
  mrr_growth_p50 NUMERIC(7,2),
  mrr_growth_p75 NUMERIC(7,2)
);

-- Requête typique : prendre la ligne la plus récente
CREATE INDEX idx_peer_benchmarks_computed_at
  ON peer_benchmarks (computed_at DESC);

-- Nettoyage automatique : garder 30 jours de snapshots
-- (géré dans compute-peer-benchmarks, pas via trigger)
