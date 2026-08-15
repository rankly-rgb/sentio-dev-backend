-- ============================================================
-- Lot 8 (suite) — capture des 4 dernières RPC créées hors migration
-- ============================================================
--
-- Trouvées par le premier drift-check réellement exécuté : le rejeu de
-- l'historique dans la base shadow de `supabase db diff` s'arrêtait sur le
-- GRANT du Lot 1 portant sur `get_mrr_movements_summary`, fonction qu'aucune
-- migration ne crée. Un recensement corrigé (n'acceptant que les `CREATE`,
-- là où le premier passage acceptait à tort un `GRANT` comme une déclaration)
-- en a trouvé exactement quatre :
--
--   · get_mrr_movements_summary(date, date)
--   · get_mrr_trend(date, date)
--   · get_playbook_eligible_accounts(uuid, integer, integer)
--   · get_segment_accounts(text, text, text, integer, integer)
--
-- Les quatre sont appelées par le frontend et figurent dans la matrice de
-- privilèges du Lot 1 — elles étaient donc auditées, grantées et utilisées,
-- mais leur définition n'existait nulle part en git.
--
-- Reprises **verbatim de pg_get_functiondef** sur le projet (2026-08-15).
-- Aucune correction : ce fichier met l'existant sous contrôle de version.
-- Les écarts relevés au passage sont dans PARKING_LOT.md.
--
-- `CREATE OR REPLACE` : no-op sémantique sur le projet, où ces fonctions
-- existent déjà à l'identique.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_mrr_movements_summary(p_start_date date DEFAULT ((CURRENT_DATE - '30 days'::interval))::date, p_end_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(movement_date date, new_mrr_cents bigint, expansion_mrr_cents bigint, contraction_mrr_cents bigint, churn_mrr_cents bigint, reactivation_mrr_cents bigint, net_mrr_cents bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id UUID;
BEGIN
  v_org_id := public.user_organization_id();
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'User has no associated organization';
  END IF;

  -- Cap range to 365 days max
  IF p_end_date - p_start_date > 365 THEN
    p_start_date := p_end_date - 365;
  END IF;

  RETURN QUERY
  SELECT
    m.movement_date,
    COALESCE(SUM(CASE WHEN m.movement_type = 'new'          THEN m.amount_cents END), 0)::BIGINT AS new_mrr_cents,
    COALESCE(SUM(CASE WHEN m.movement_type = 'expansion'    THEN m.amount_cents END), 0)::BIGINT AS expansion_mrr_cents,
    COALESCE(SUM(CASE WHEN m.movement_type = 'contraction'  THEN m.amount_cents END), 0)::BIGINT AS contraction_mrr_cents,
    COALESCE(SUM(CASE WHEN m.movement_type = 'churn'        THEN m.amount_cents END), 0)::BIGINT AS churn_mrr_cents,
    COALESCE(SUM(CASE WHEN m.movement_type = 'reactivation' THEN m.amount_cents END), 0)::BIGINT AS reactivation_mrr_cents,
    COALESCE(SUM(
      CASE
        WHEN m.movement_type IN ('new', 'expansion', 'reactivation') THEN m.amount_cents
        WHEN m.movement_type IN ('contraction', 'churn')             THEN -m.amount_cents
        ELSE 0
      END
    ), 0)::BIGINT AS net_mrr_cents
  FROM mrr_movements m
  WHERE m.organization_id = v_org_id
    AND m.movement_date >= p_start_date
    AND m.movement_date <= p_end_date
  GROUP BY m.movement_date
  ORDER BY m.movement_date ASC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_mrr_trend(p_start_date date DEFAULT ((CURRENT_DATE - '30 days'::interval))::date, p_end_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(snapshot_date date, total_mrr_cents bigint, account_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id UUID;
BEGIN
  v_org_id := public.user_organization_id();
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'User has no associated organization';
  END IF;

  -- Cap range to 365 days max
  IF p_end_date - p_start_date > 365 THEN
    p_start_date := p_end_date - 365;
  END IF;

  RETURN QUERY
  SELECT
    sh.snapshot_date,
    COALESCE(SUM(sh.mrr_cents), 0)::BIGINT AS total_mrr_cents,
    COUNT(DISTINCT sh.account_id)           AS account_count
  FROM score_history sh
  WHERE sh.organization_id = v_org_id
    AND sh.snapshot_date >= p_start_date
    AND sh.snapshot_date <= p_end_date
  GROUP BY sh.snapshot_date
  ORDER BY sh.snapshot_date ASC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_playbook_eligible_accounts(p_playbook_id uuid, p_limit integer DEFAULT 200, p_offset integer DEFAULT 0)
 RETURNS TABLE(account_id uuid, stripe_customer_id text, mrr_cents integer, churn_risk_score numeric, health_score numeric, expansion_score numeric, urgency text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.get_segment_accounts(p_segment text, p_sort_by text DEFAULT 'mrr_cents'::text, p_sort_order text DEFAULT 'desc'::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, stripe_customer_id text, hubspot_company_id text, plan_tier text, billing_interval text, mrr_cents integer, seat_count integer, seat_limit integer, contract_end_date date, health_score numeric, churn_risk_score numeric, expansion_score numeric, product_usage_score numeric, total_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id UUID;
BEGIN
  -- Resolve caller's organization
  v_org_id := public.user_organization_id();
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'User has no associated organization';
  END IF;

  -- Validate segment parameter
  IF p_segment NOT IN (
    'champions', 'en_expansion', 'stables', 'a_risque_leger',
    'en_danger_critique', 'impayes', 'en_churn', 'nouveaux'
  ) THEN
    RAISE EXCEPTION 'Invalid segment: %', p_segment;
  END IF;

  -- Validate sort_by parameter
  IF p_sort_by NOT IN ('mrr_cents', 'health_score', 'churn_risk_score', 'expansion_score') THEN
    p_sort_by := 'mrr_cents';
  END IF;

  -- Validate sort_order parameter
  IF p_sort_order NOT IN ('asc', 'desc') THEN
    p_sort_order := 'desc';
  END IF;

  -- Cap limit to prevent abuse
  IF p_limit > 10000 THEN
    p_limit := 10000;
  END IF;

  RETURN QUERY
  WITH filtered AS (
    SELECT a.*
    FROM accounts a
    INNER JOIN segment_memberships sm ON sm.account_id = a.id
    INNER JOIN account_segments seg ON seg.id = sm.segment_id
    WHERE a.organization_id = v_org_id
      AND seg.organization_id = v_org_id
      AND sm.organization_id = v_org_id
      AND seg.segment_type = p_segment
      AND sm.status = 'active'
      AND seg.is_active = TRUE
  )
  SELECT
    f.id,
    f.stripe_customer_id,
    f.hubspot_company_id,
    f.plan_tier,
    f.billing_interval,
    f.mrr_cents,
    f.seat_count,
    f.seat_limit,
    f.contract_end_date,
    f.health_score,
    f.churn_risk_score,
    f.expansion_score,
    f.product_usage_score,
    COUNT(*) OVER() AS total_count
  FROM filtered f
  ORDER BY
    CASE WHEN p_sort_order = 'desc' THEN
      CASE p_sort_by
        WHEN 'mrr_cents'        THEN f.mrr_cents
        WHEN 'health_score'     THEN f.health_score::INTEGER
        WHEN 'churn_risk_score' THEN f.churn_risk_score::INTEGER
        WHEN 'expansion_score'  THEN f.expansion_score::INTEGER
        ELSE f.mrr_cents
      END
    END DESC NULLS LAST,
    CASE WHEN p_sort_order = 'asc' THEN
      CASE p_sort_by
        WHEN 'mrr_cents'        THEN f.mrr_cents
        WHEN 'health_score'     THEN f.health_score::INTEGER
        WHEN 'churn_risk_score' THEN f.churn_risk_score::INTEGER
        WHEN 'expansion_score'  THEN f.expansion_score::INTEGER
        ELSE f.mrr_cents
      END
    END ASC NULLS LAST
  LIMIT p_limit OFFSET p_offset;
END;
$function$;

-- ── Privilèges ─────────────────────────────────────────────
-- Matrice relevée en direct sur le projet (has_function_privilege) :
-- anon = non, authenticated = oui, service_role = oui — identique pour les
-- quatre. Reposée ici parce que ce fichier s'exécute APRÈS le lockdown du
-- Lot 1 : sur une base neuve, ces fonctions naîtraient sinon avec l'EXECUTE
-- par défaut de PUBLIC et échapperaient à l'assertion CI a1.
REVOKE ALL ON FUNCTION public.get_mrr_movements_summary(date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_mrr_trend(date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_playbook_eligible_accounts(uuid, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_segment_accounts(text, text, text, integer, integer) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_mrr_movements_summary(date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_mrr_trend(date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_playbook_eligible_accounts(uuid, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_segment_accounts(text, text, text, integer, integer) TO authenticated, service_role;
