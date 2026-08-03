-- Capture des 3 fonctions Postgres découvertes en drift (2026-08-03) :
-- get_playbook_detail, get_playbook_full_detail, transition_playbook_status
-- existaient déjà en production (confirmé via pg_get_functiondef() du live
-- DB), consommées directement par le frontend (usePlaybookDetail,
-- transitionPlaybookStatus dans playbook-queries.ts), mais n'avaient jamais
-- été capturées dans une migration — invisibles en revue de code, perdues
-- sur tout rebuild d'environnement. Elles opèrent sur playbooks +
-- playbook_executions (le moteur playbook générique, présent depuis la
-- migration fondatrice 20260301000005_phase4_intelligence.sql, antérieur
-- à tous les chantiers de ce projet — distinct du modèle CSV export
-- playbook_runs du chantier A, voir _shared/playbook-targeting.ts).
--
-- Pur CREATE OR REPLACE FUNCTION à partir du texte exact retourné par
-- pg_get_functiondef() sur le live DB — AUCUN changement de comportement
-- dans cette migration. La question vocabulaire running/in_progress a été
-- vérifiée séparément (get_playbook_detail expose déjà les deux clés avec
-- la même valeur, rien à corriger) et n'est pas traitée ici.
--
-- Trouvé au passage, non corrigé ici (hors scope "capture sans
-- changement") : get_playbook_full_detail référence pe.mrr_recovered_cents
-- et pe.mrr_expansion_cents sur playbook_executions — ni l'une ni l'autre
-- de ces deux colonnes n'existe dans une migration trackée pour cette
-- table (seule playbooks.mrr_recovered_cents et playbooks.mrr_expanded_cents,
-- nom différent, existent). PL/pgSQL ne valide pas les références de
-- colonnes des requêtes internes à la création de la fonction, seulement
-- au premier appel — cette migration s'applique donc sans erreur, mais un
-- rebuild d'environnement propre échouerait au premier appel de
-- get_playbook_full_detail sur ces deux colonnes manquantes. Nécessite son
-- propre correctif (ajout de colonnes), volontairement pas inclus ici.

CREATE OR REPLACE FUNCTION public.get_playbook_full_detail(p_playbook_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.get_playbook_detail(p_playbook_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_raw JSON;
  v_result JSON;
BEGIN
  v_raw := public.get_playbook_full_detail(p_playbook_id);

  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;

  -- Garder la structure nested originale + ajouter aliases frontend
  SELECT json_build_object(
    -- Nested playbook (frontend: data.playbook.id, data.playbook.title, etc.)
    'playbook',                    v_raw->'playbook',
    -- Original stats (frontend may use data.stats.executions_total)
    'stats',                       v_raw->'stats',
    -- Alias execution_stats (frontend may use data.execution_stats.total)
    'execution_stats', json_build_object(
      'total',               (v_raw->'stats'->>'executions_total')::integer,
      'total_executions',    (v_raw->'stats'->>'executions_total')::integer,
      'completed',           (v_raw->'stats'->>'executions_completed')::integer,
      'failed',              (v_raw->'stats'->>'executions_failed')::integer,
      'in_progress',         (v_raw->'stats'->>'executions_in_progress')::integer,
      'running',             (v_raw->'stats'->>'executions_in_progress')::integer,
      'pending',             0,
      'targeted_count',      (v_raw->'stats'->>'targeted_count')::integer,
      'reached_count',       (v_raw->'stats'->>'reached_count')::integer,
      'converted_count',     (v_raw->'stats'->>'converted_count')::integer,
      'mrr_recovered_cents', (v_raw->'stats'->>'mrr_recovered_cents')::integer,
      'mrr_expansion_cents', (v_raw->'stats'->>'mrr_expansion_cents')::integer,
      'last_executed_at',    v_raw->'playbook'->'last_executed_at'
    ),
    -- Original affected_accounts_summary
    'affected_accounts_summary',   v_raw->'affected_accounts_summary',
    -- Alias eligible_accounts (frontend may use data.eligible_accounts.total)
    'eligible_accounts', json_build_object(
      'total',             (v_raw->'affected_accounts_summary'->>'total')::integer,
      'mrr_at_risk_cents', (v_raw->'affected_accounts_summary'->>'mrr_at_risk_cents')::integer,
      'by_urgency',        v_raw->'affected_accounts_summary'->'by_urgency',
      'urgent_count',      (v_raw->'affected_accounts_summary'->'by_urgency'->>'urgent')::integer,
      'surveiller_count',  (v_raw->'affected_accounts_summary'->'by_urgency'->>'watch')::integer,
      'stable_count',      (v_raw->'affected_accounts_summary'->'by_urgency'->>'stable')::integer
    ),
    -- Scalar alias
    'current_eligible_count',      (v_raw->'stats'->>'eligible_count')::integer,
    -- Raw conditions and actions
    'conditions',                  v_raw->'conditions',
    'actions',                     v_raw->'actions'
  )
  INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.transition_playbook_status(p_playbook_id uuid, p_target_status text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current_status TEXT;
  v_org_id UUID;
  v_allowed_transitions JSONB := '{
    "draft":     ["active", "archived"],
    "active":    ["draft", "archived"],
    "paused":    ["active", "archived"],
    "completed": ["archived"],
    "archived":  []
  }';
BEGIN
  -- Vérification multi-tenant
  v_org_id := public.user_organization_id();
  IF v_org_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Non autorisé : aucun contexte organisation');
  END IF;

  -- Récupérer le statut actuel avec vérification org_id
  SELECT status INTO v_current_status
  FROM public.playbooks
  WHERE id = p_playbook_id
    AND organization_id = v_org_id;

  IF v_current_status IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Playbook non trouvé ou accès refusé');
  END IF;

  -- Valider le statut cible
  IF p_target_status NOT IN ('draft', 'active', 'paused', 'completed', 'archived') THEN
    RETURN json_build_object('success', false, 'error', 'Statut cible invalide : ' || p_target_status);
  END IF;

  -- Vérification de la transition
  IF NOT (v_allowed_transitions->v_current_status @> to_jsonb(p_target_status)) THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Transition non autorisée : ' || v_current_status || ' → ' || p_target_status
    );
  END IF;

  -- Appliquer la transition
  UPDATE public.playbooks
  SET status = p_target_status,
      updated_at = NOW(),
      activated_at = CASE WHEN p_target_status = 'active' AND activated_at IS NULL THEN NOW() ELSE activated_at END,
      deactivated_at = CASE WHEN p_target_status = 'archived' THEN NOW() ELSE deactivated_at END
  WHERE id = p_playbook_id
    AND organization_id = v_org_id;

  RETURN json_build_object('success', true, 'new_status', p_target_status);
END;
$function$;
