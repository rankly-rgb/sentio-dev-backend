-- ============================================================
-- accounts_with_priority : bascule sur churn_risk_band (Scoring V2)
-- ============================================================
--
-- Chantier 2 (câblage v3 des endpoints de lecture). churn_risk_score n'a
-- plus la même distribution sous le modèle additif v3 (voir
-- 20260725000001_scoring_engine_v3.sql) : les seuils numériques hérités
-- (>=80/>=50) calibrés sur l'ancien "100-health+additifs" ne veulent plus
-- rien dire. churn_risk_band ('low'/'watch'/'high') est calculé par
-- calculate-scores selon les bandes du nouveau modèle et reste correct par
-- construction — la vue le lit directement plutôt que de dupliquer sa
-- propre lecture de seuils numériques qui deviendrait immédiatement
-- désynchronisée du reste du produit (weekly-digest, churn-alert
-- utilisent déjà churn_risk_band).
--
-- health_score reste un seuil numérique (0-100, sémantique inchangée par
-- le passage v3, seule sa disponibilité a changé — voir health_score_status)
-- donc les seuils health_score <= 30/55 ne sont PAS touchés ici. Le
-- recalibrage fin de ces deux seuils reste un chantier séparé, après
-- collecte de données réelles sous le nouveau modèle (RUNBOOK.md §7).
--
-- priority_label (decreasing priority, mutually exclusive):
--   1. 'critical'   : churn_risk_band = 'high' OR health_score <= 30
--   2. 'watch'      : churn_risk_band = 'watch' OR health_score <= 55
--   3. 'new'        : created_at within the last 90 days AND churn_risk_band = 'low'
--   4. 'stable'     : all other cases
--
-- Un compte avec health_score_status='insufficient' (health_score NULL) et
-- churn_risk_band='low' tombe dans 'new' (si récent) ou 'stable' — jamais
-- 'critical'/'watch' à cause d'un health_score NULL, puisque `NULL <= 30`
-- est NULL (falsy) en SQL, pas une fausse alerte silencieuse.

-- CREATE OR REPLACE VIEW ne peut pas être utilisé ici : Postgres interdit de
-- repositionner une colonne existante, et `a.*` a gagné de nouvelles colonnes
-- avec 20260725000001 (ajoutées à la fin de accounts), ce qui décale
-- priority_label plus loin dans la liste positionnelle — Postgres refuse ça
-- ("cannot change name of view column ... to ..."). DROP + CREATE évite le
-- problème ; view = pas de données, pas de perte, GRANT réappliqué juste après.
DROP VIEW IF EXISTS public.accounts_with_priority;

CREATE VIEW public.accounts_with_priority
WITH (security_invoker = true) AS
SELECT
  a.*,
  CASE
    WHEN a.churn_risk_band = 'high' OR a.health_score <= 30 THEN 'critical'
    WHEN a.churn_risk_band = 'watch' OR a.health_score <= 55 THEN 'watch'
    WHEN a.created_at >= (now() - interval '90 days') AND a.churn_risk_band = 'low' THEN 'new'
    ELSE 'stable'
  END AS priority_label
FROM public.accounts a;

GRANT SELECT ON public.accounts_with_priority TO authenticated, service_role;
