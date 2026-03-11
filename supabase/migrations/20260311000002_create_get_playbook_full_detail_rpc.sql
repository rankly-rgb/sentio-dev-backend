-- RPC: get_playbook_full_detail
-- Paramètres:
--   p_playbook_id UUID
--
-- Retourne un JSON avec la structure suivante (contrat frontend) :
-- {
--   "playbook": {
--     "id": "uuid",
--     "title": "string",
--     "description": "string",
--     "status": "draft" | "active" | "paused" | "completed" | "archived",
--     "priority": "critical" | "high" | "medium" | "low",
--     "playbook_type": "manual" | "automated" | "semi_automated" | "template",
--     "template_category": "string",
--     "requires_approval": boolean,
--     "is_template": boolean,
--     "is_automated": boolean,
--     "execution_frequency": "daily" | "weekly" | "monthly" | null,
--     "last_executed_at": "ISO8601" | null,
--     "created_at": "ISO8601",
--     "updated_at": "ISO8601"
--   },
--   "stats": {
--     "targeted_count": integer,       -- comptes distincts ayant eu au moins 1 exécution
--     "eligible_count": integer,        -- comptes répondant aux eligibility_criteria (calculé dynamiquement)
--     "reached_count": integer,         -- comptes ayant au moins 1 exécution completed/running
--     "converted_count": integer,       -- comptes marqués account_converted = true
--     "mrr_recovered_cents": integer,
--     "mrr_expansion_cents": integer,
--     "executions_total": integer,
--     "executions_completed": integer,
--     "executions_failed": integer,
--     "executions_in_progress": integer
--   },
--   "affected_accounts_summary": {
--     "total": integer,
--     "mrr_at_risk_cents": integer,
--     "by_urgency": {
--       "urgent": integer,              -- churn_risk_score >= 70
--       "watch": integer,               -- churn_risk_score 40-69
--       "stable": integer               -- churn_risk_score < 40
--     }
--   },
--   "conditions": jsonb,               -- eligibility_criteria brut du playbook
--   "actions": jsonb                   -- actions brut du playbook
-- }

CREATE OR REPLACE FUNCTION public.get_playbook_full_detail(
  p_playbook_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
  v_playbook RECORD;
  v_stats JSON;
  v_affected JSON;
  v_eligible_count INTEGER;
  v_result JSON;
BEGIN
  -- Vérification multi-tenant explicite
  v_org_id := public.user_organization_id();
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no organization context';
  END IF;

  -- Récupérer le playbook avec vérification org_id
  SELECT *
  INTO v_playbook
  FROM public.playbooks
  WHERE id = p_playbook_id
    AND organization_id = v_org_id;

  IF v_playbook IS NULL THEN
    RETURN NULL;
  END IF;

  -- Stats d'exécution
  SELECT json_build_object(
    'targeted_count',        COALESCE(COUNT(DISTINCT pe.account_id), 0),
    'reached_count',         COALESCE(SUM(CASE WHEN pe.execution_status IN ('completed', 'running', 'partially_completed') THEN 1 ELSE 0 END), 0),
    'converted_count',       COALESCE(SUM(CASE WHEN pe.account_converted = true THEN 1 ELSE 0 END), 0),
    'mrr_recovered_cents',   COALESCE(SUM(pe.mrr_recovered_cents), 0),
    'mrr_expansion_cents',   COALESCE(SUM(pe.mrr_expansion_cents), 0),
    'executions_total',      COUNT(pe.id),
    'executions_completed',  COALESCE(SUM(CASE WHEN pe.execution_status = 'completed' THEN 1 ELSE 0 END), 0),
    'executions_failed',     COALESCE(SUM(CASE WHEN pe.execution_status = 'failed' THEN 1 ELSE 0 END), 0),
    'executions_in_progress',COALESCE(SUM(CASE WHEN pe.execution_status IN ('running', 'pending') THEN 1 ELSE 0 END), 0)
  )
  INTO v_stats
  FROM public.playbook_executions pe
  WHERE pe.playbook_id = p_playbook_id
    AND pe.organization_id = v_org_id;

  -- Comptes éligibles et résumé affected_accounts
  -- Applique les conditions eligibility_criteria du playbook sur les comptes de l'org
  WITH eligible_accounts AS (
    SELECT a.id, a.churn_risk_score, a.mrr_cents
    FROM public.accounts a
    WHERE a.organization_id = v_org_id
      -- Filtre dynamique basé sur eligibility_criteria
      AND (
        v_playbook.eligibility_criteria IS NULL
        OR v_playbook.eligibility_criteria = '{}'::jsonb
        OR (v_playbook.eligibility_criteria->'conditions') IS NULL
        OR jsonb_array_length(COALESCE(v_playbook.eligibility_criteria->'conditions', '[]'::jsonb)) = 0
        OR (
          -- Appliquer chaque condition connue
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
  SELECT json_build_object(
    'total',            COUNT(ea.id),
    'mrr_at_risk_cents', COALESCE(SUM(ea.mrr_cents), 0),
    'by_urgency', json_build_object(
      'urgent', COALESCE(SUM(CASE WHEN ea.churn_risk_score >= 70 THEN 1 ELSE 0 END), 0),
      'watch',  COALESCE(SUM(CASE WHEN ea.churn_risk_score >= 40 AND ea.churn_risk_score < 70 THEN 1 ELSE 0 END), 0),
      'stable', COALESCE(SUM(CASE WHEN ea.churn_risk_score < 40 OR ea.churn_risk_score IS NULL THEN 1 ELSE 0 END), 0)
    )
  ),
  COUNT(ea.id)
  INTO v_affected, v_eligible_count
  FROM eligible_accounts ea;

  -- Construire le résultat final
  SELECT json_build_object(
    'playbook', json_build_object(
      'id', v_playbook.id,
      'title', v_playbook.title,
      'description', v_playbook.description,
      'status', v_playbook.status,
      'priority', v_playbook.priority,
      'playbook_type', v_playbook.playbook_type,
      'template_category', v_playbook.template_category,
      'requires_approval', v_playbook.requires_approval,
      'is_template', v_playbook.is_template,
      'is_automated', v_playbook.is_automated,
      'execution_frequency', v_playbook.execution_frequency,
      'last_executed_at', v_playbook.last_executed_at,
      'created_at', v_playbook.created_at,
      'updated_at', v_playbook.updated_at
    ),
    'stats', (
      SELECT json_build_object(
        'targeted_count',        (v_stats->>'targeted_count')::integer,
        'eligible_count',        v_eligible_count,
        'reached_count',         (v_stats->>'reached_count')::integer,
        'converted_count',       (v_stats->>'converted_count')::integer,
        'mrr_recovered_cents',   (v_stats->>'mrr_recovered_cents')::integer,
        'mrr_expansion_cents',   (v_stats->>'mrr_expansion_cents')::integer,
        'executions_total',      (v_stats->>'executions_total')::integer,
        'executions_completed',  (v_stats->>'executions_completed')::integer,
        'executions_failed',     (v_stats->>'executions_failed')::integer,
        'executions_in_progress',(v_stats->>'executions_in_progress')::integer
      )
    ),
    'affected_accounts_summary', v_affected,
    'conditions', COALESCE(v_playbook.eligibility_criteria, '{}'::jsonb),
    'actions',    COALESCE(v_playbook.actions, '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

-- Accès pour les utilisateurs authentifiés
GRANT EXECUTE ON FUNCTION public.get_playbook_full_detail(UUID) TO authenticated;
