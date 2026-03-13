-- RPC: get_playbook_eligible_accounts
-- Retourne les comptes individuels éligibles d'un playbook avec classification d'urgence.
-- Utilisé par playbook-crud GET /:id pour la section "Comptes concernés".
-- Single source of truth — élimine le bug des deux blocs "Comptes concernés".
--
-- Paramètres:
--   p_playbook_id UUID — ID du playbook
--   p_limit INTEGER (default 200) — pagination
--   p_offset INTEGER (default 0) — pagination
--
-- Retourne TABLE:
--   account_id, stripe_customer_id, mrr_cents, churn_risk_score, health_score, expansion_score, urgency

CREATE OR REPLACE FUNCTION public.get_playbook_eligible_accounts(
  p_playbook_id UUID,
  p_limit INTEGER DEFAULT 200,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  account_id UUID,
  stripe_customer_id TEXT,
  mrr_cents INTEGER,
  churn_risk_score NUMERIC,
  health_score NUMERIC,
  expansion_score NUMERIC,
  urgency TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
  v_playbook RECORD;
BEGIN
  -- Vérification multi-tenant explicite
  v_org_id := public.user_organization_id();
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no organization context';
  END IF;

  -- Cap limit à 10000 pour prévenir les abus
  IF p_limit > 10000 THEN
    p_limit := 10000;
  END IF;
  IF p_limit < 1 THEN
    p_limit := 1;
  END IF;
  IF p_offset < 0 THEN
    p_offset := 0;
  END IF;

  -- Récupérer le playbook avec vérification org_id
  SELECT *
  INTO v_playbook
  FROM public.playbooks
  WHERE id = p_playbook_id
    AND organization_id = v_org_id;

  IF v_playbook IS NULL THEN
    RETURN;
  END IF;

  -- Retourner les comptes éligibles avec urgence
  RETURN QUERY
  WITH eligible AS (
    SELECT a.id, a.stripe_customer_id, a.mrr_cents, a.churn_risk_score, a.health_score, a.expansion_score
    FROM public.accounts a
    WHERE a.organization_id = v_org_id
      AND (
        v_playbook.eligibility_criteria IS NULL
        OR v_playbook.eligibility_criteria = '{}'::jsonb
        OR (v_playbook.eligibility_criteria->'conditions') IS NULL
        OR jsonb_array_length(COALESCE(v_playbook.eligibility_criteria->'conditions', '[]'::jsonb)) = 0
        OR (
          -- churn_risk_score gte
          (
            NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(v_playbook.eligibility_criteria->'conditions') c
              WHERE c->>'field' = 'churn_risk_score' AND c->>'operator' = 'gte'
            )
            OR a.churn_risk_score >= (
              SELECT (c->>'value')::numeric
              FROM jsonb_array_elements(v_playbook.eligibility_criteria->'conditions') c
              WHERE c->>'field' = 'churn_risk_score' AND c->>'operator' = 'gte'
              LIMIT 1
            )
          )
          AND
          -- health_score lte
          (
            NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(v_playbook.eligibility_criteria->'conditions') c
              WHERE c->>'field' = 'health_score' AND c->>'operator' = 'lte'
            )
            OR a.health_score <= (
              SELECT (c->>'value')::numeric
              FROM jsonb_array_elements(v_playbook.eligibility_criteria->'conditions') c
              WHERE c->>'field' = 'health_score' AND c->>'operator' = 'lte'
              LIMIT 1
            )
          )
          AND
          -- health_score gte
          (
            NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(v_playbook.eligibility_criteria->'conditions') c
              WHERE c->>'field' = 'health_score' AND c->>'operator' = 'gte'
            )
            OR a.health_score >= (
              SELECT (c->>'value')::numeric
              FROM jsonb_array_elements(v_playbook.eligibility_criteria->'conditions') c
              WHERE c->>'field' = 'health_score' AND c->>'operator' = 'gte'
              LIMIT 1
            )
          )
          AND
          -- expansion_score gte
          (
            NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(v_playbook.eligibility_criteria->'conditions') c
              WHERE c->>'field' = 'expansion_score' AND c->>'operator' = 'gte'
            )
            OR a.expansion_score >= (
              SELECT (c->>'value')::numeric
              FROM jsonb_array_elements(v_playbook.eligibility_criteria->'conditions') c
              WHERE c->>'field' = 'expansion_score' AND c->>'operator' = 'gte'
              LIMIT 1
            )
          )
          AND
          -- mrr_cents gte
          (
            NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(v_playbook.eligibility_criteria->'conditions') c
              WHERE c->>'field' = 'mrr_cents' AND c->>'operator' = 'gte'
            )
            OR a.mrr_cents >= (
              SELECT (c->>'value')::integer
              FROM jsonb_array_elements(v_playbook.eligibility_criteria->'conditions') c
              WHERE c->>'field' = 'mrr_cents' AND c->>'operator' = 'gte'
              LIMIT 1
            )
          )
          AND
          -- product_usage_score lte
          (
            NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(v_playbook.eligibility_criteria->'conditions') c
              WHERE c->>'field' = 'product_usage_score' AND c->>'operator' = 'lte'
            )
            OR a.product_usage_score <= (
              SELECT (c->>'value')::numeric
              FROM jsonb_array_elements(v_playbook.eligibility_criteria->'conditions') c
              WHERE c->>'field' = 'product_usage_score' AND c->>'operator' = 'lte'
              LIMIT 1
            )
          )
          AND
          -- plan_tier in
          (
            NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(v_playbook.eligibility_criteria->'conditions') c
              WHERE c->>'field' = 'plan_tier' AND c->>'operator' = 'in'
            )
            OR a.plan_tier = ANY(
              ARRAY(
                SELECT jsonb_array_elements_text(
                  (SELECT c->'value'
                   FROM jsonb_array_elements(v_playbook.eligibility_criteria->'conditions') c
                   WHERE c->>'field' = 'plan_tier' AND c->>'operator' = 'in'
                   LIMIT 1)
                )
              )
            )
          )
        )
      )
  )
  SELECT
    ea.id AS account_id,
    ea.stripe_customer_id,
    ea.mrr_cents,
    ea.churn_risk_score,
    ea.health_score,
    ea.expansion_score,
    CASE
      WHEN ea.churn_risk_score >= 70 THEN 'urgent'
      WHEN ea.churn_risk_score >= 40 THEN 'surveiller'
      ELSE 'stable'
    END AS urgency
  FROM eligible ea
  ORDER BY ea.churn_risk_score DESC NULLS LAST, ea.mrr_cents DESC NULLS LAST
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- Accès pour les utilisateurs authentifiés
GRANT EXECUTE ON FUNCTION public.get_playbook_eligible_accounts(UUID, INTEGER, INTEGER) TO authenticated;
