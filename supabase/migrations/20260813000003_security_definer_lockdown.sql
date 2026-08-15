-- Lot 1 — verrouillage des fonctions SECURITY DEFINER exposées à anon/PUBLIC
--
-- Audit Phase 0 (2026-08-13) : 24 fonctions SECURITY DEFINER du schéma public
-- avaient EXECUTE accordé à anon/PUBLIC, dont 6 fonctions Vault
-- (lecture/écriture/suppression de secrets sans aucune vérification
-- d'identité) et cron_dispatch_via_vault (déclenche n'importe quelle Edge
-- Function avec le token service_role, sans allowlist). Voir le rapport
-- Phase 0 pour le détail complet par fonction.
--
-- Stratégie : REVOKE en masse depuis PUBLIC/anon/authenticated sur toutes
-- les fonctions SECURITY DEFINER de public, puis re-GRANT explicite,
-- fonction par fonction, au rôle strictement nécessaire. Le GRANT devient
-- une décision documentée, plus un défaut hérité de la création de fonction.
--
-- Piège identifié avant d'écrire cette migration : user_organization_id()
-- et user_role() sont appelées à l'intérieur des policies RLS. Si
-- authenticated perd EXECUTE dessus, toutes les policies échouent et
-- l'application entière tombe. Ces deux-là sont explicitement ré-accordées
-- à authenticated ci-dessous, en premier, avant tout autre traitement.

-- ============================================================
-- 1. REVOKE en masse — PUBLIC, anon, authenticated
--    (jamais service_role : ce rôle n'est pas touché, il garde son
--    exécution implicite via l'appartenance de rôle Supabase standard)
-- ============================================================
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef = true
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC, anon, authenticated',
      r.nspname, r.proname, r.args
    );
  END LOOP;
END $$;

-- ============================================================
-- 2. Helpers RLS — authenticated obligatoire (sinon RLS casse)
--    proconfig confirmé NULL (pas de search_path explicite) pour ces deux
--    au moment de l'audit — pinné explicitement ici.
-- ============================================================
ALTER FUNCTION public.user_organization_id() SET search_path = public, pg_temp;
ALTER FUNCTION public.user_role() SET search_path = public, pg_temp;

DO $grant$ BEGIN
  IF to_regprocedure('public.user_organization_id()') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.user_organization_id() TO authenticated';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.user_organization_id() absente à ce stade du rejeu';
  END IF;
END $grant$;
DO $grant$ BEGIN
  IF to_regprocedure('public.user_role()') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.user_role() TO authenticated';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.user_role() absente à ce stade du rejeu';
  END IF;
END $grant$;

-- ============================================================
-- Rejouabilité (ajouté 2026-08-15)
-- ============================================================
-- Les GRANT ci-dessous étaient des instructions nues. Sur le projet dev, où
-- cette migration est déjà appliquée, toutes leurs cibles existent — mais sur
-- une base neuve, plusieurs de ces fonctions ne sont pas encore là au moment
-- où ce fichier s'exécute :
--   · get_mrr_movements_summary / get_mrr_trend /
--     get_playbook_eligible_accounts / get_segment_accounts
--     n'étaient créées par AUCUNE migration (capturées par 20260815000004)
--   · get_playbook_export_summary est créée par 20260815000002, donc APRÈS
--     ce fichier
-- Un GRANT sur une fonction absente est une erreur dure : le rejeu s'arrêtait
-- ici, ce qui rendait `supabase db diff --linked` inutilisable et la détection
-- de dérive de schéma structurellement aveugle.
--
-- Chaque GRANT est donc désormais conditionné par to_regprocedure(). Sur une
-- base où la fonction existe (le projet dev), le comportement est identique
-- au précédent. Ailleurs, le GRANT est sauté avec un NOTICE, et la migration
-- qui crée la fonction pose elle-même ses propres GRANT.
-- ============================================================

-- ============================================================
-- 3. RPC applicatives — authenticated (appelées depuis le frontend avec le
--    JWT utilisateur ; toutes dérivent déjà l'org via user_organization_id()
--    en interne, vérifié fonction par fonction lors de l'audit Phase 0 —
--    le GRANT restreint la surface, pas la logique métier qui était déjà
--    correcte)
-- ============================================================
DO $grant$ BEGIN
  IF to_regprocedure('public.get_mrr_movements_summary(date, date)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_mrr_movements_summary(date, date) TO authenticated';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.get_mrr_movements_summary(date, date) absente à ce stade du rejeu';
  END IF;
END $grant$;
DO $grant$ BEGIN
  IF to_regprocedure('public.get_mrr_trend(date, date)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_mrr_trend(date, date) TO authenticated';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.get_mrr_trend(date, date) absente à ce stade du rejeu';
  END IF;
END $grant$;
DO $grant$ BEGIN
  IF to_regprocedure('public.get_playbook_detail(uuid)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_playbook_detail(uuid) TO authenticated';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.get_playbook_detail(uuid) absente à ce stade du rejeu';
  END IF;
END $grant$;
DO $grant$ BEGIN
  IF to_regprocedure('public.get_playbook_eligible_accounts(uuid, integer, integer)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_playbook_eligible_accounts(uuid, integer, integer) TO authenticated';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.get_playbook_eligible_accounts(uuid, integer, integer) absente à ce stade du rejeu';
  END IF;
END $grant$;
DO $grant$ BEGIN
  IF to_regprocedure('public.get_playbook_export_summary(uuid, jsonb)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_playbook_export_summary(uuid, jsonb) TO authenticated';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.get_playbook_export_summary(uuid, jsonb) absente à ce stade du rejeu';
  END IF;
END $grant$;
DO $grant$ BEGIN
  IF to_regprocedure('public.get_playbook_full_detail(uuid)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_playbook_full_detail(uuid) TO authenticated';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.get_playbook_full_detail(uuid) absente à ce stade du rejeu';
  END IF;
END $grant$;
DO $grant$ BEGIN
  IF to_regprocedure('public.get_segment_accounts(text, text, text, integer, integer)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_segment_accounts(text, text, text, integer, integer) TO authenticated';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.get_segment_accounts(text, text, text, integer, integer) absente à ce stade du rejeu';
  END IF;
END $grant$;
DO $grant$ BEGIN
  IF to_regprocedure('public.transition_playbook_status(uuid, text)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.transition_playbook_status(uuid, text) TO authenticated';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.transition_playbook_status(uuid, text) absente à ce stade du rejeu';
  END IF;
END $grant$;

-- ============================================================
-- 4. Fonctions de trigger — AUCUN GRANT à personne.
--    Postgres interdit structurellement d'appeler directement une fonction
--    RETURNS trigger via SQL/RPC (pas seulement une convention) : elles ne
--    sont invocables que par le mécanisme de trigger, quel que soit le
--    GRANT. Rien à faire ici au-delà du REVOKE en masse déjà appliqué —
--    listées pour la traçabilité de l'audit :
--    handle_new_user, handle_new_user_signup, on_organization_created,
--    on_playbook_activate.
-- ============================================================

-- ============================================================
-- 5. Groupe Vault + dispatch interne + fonctions appelées par les Edge
--    Functions en service_role — GRANT service_role uniquement, ET garde
--    de défense en profondeur en tête de corps (survit à un GRANT
--    ré-accordé par erreur un jour à anon/authenticated).
--
--    Garde : le snippet initialement proposé ("reject si
--    request.jwt.claims IS NOT NULL") bloquerait aussi les appels
--    service_role légitimes — vault_read_secret est appelé en RPC par
--    _shared/vault.ts (resolveHubSpotApiKey, sync-hubspot/
--    refresh-hubspot-tokens), mark_playbook_executed par
--    export-playbook-csv/index.ts:189, et seed_default_playbooks via le
--    trigger on_organization_created déclenché par l'INSERT
--    organizations de create-organization-with-invitation — les trois
--    chemins passent par PostgREST authentifiés service_role, donc
--    request.jwt.claims y est non-NULL avec role=service_role. La garde
--    ci-dessous est donc consciente du rôle, pas seulement de la
--    présence d'un JWT : elle bloque anon/authenticated (rejette tout JWT
--    dont le rôle n'est pas service_role), laisse passer service_role ET
--    les appels sans contexte PostgREST (pg_cron, migrations, trigger
--    interne hérité d'une session déjà service_role). DÉCISION AUTONOME —
--    corrige le snippet du plan pour ne pas casser le critère de passage
--    5 (aucune régression applicative), principe directeur #3
--    (réversibilité/correction avant vélocité aveugle).
-- ============================================================

CREATE OR REPLACE FUNCTION public.vault_read_secret(secret_id uuid)
RETURNS TABLE(decrypted_secret text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('request.jwt.claims', true) IS NOT NULL
     AND (current_setting('request.jwt.claims', true)::jsonb ->> 'role') IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION 'internal function: service_role only';
  END IF;

  RETURN QUERY
  SELECT vs.decrypted_secret
  FROM vault.decrypted_secrets vs
  WHERE vs.id = secret_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.vault_store_secret(p_secret text, p_name text, p_description text DEFAULT ''::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  new_id UUID;
BEGIN
  IF current_setting('request.jwt.claims', true) IS NOT NULL
     AND (current_setting('request.jwt.claims', true)::jsonb ->> 'role') IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION 'internal function: service_role only';
  END IF;

  SELECT vault.create_secret(p_secret, p_name, p_description) INTO new_id;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.vault_update_secret(secret_id uuid, new_secret text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('request.jwt.claims', true) IS NOT NULL
     AND (current_setting('request.jwt.claims', true)::jsonb ->> 'role') IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION 'internal function: service_role only';
  END IF;

  PERFORM vault.update_secret(secret_id, new_secret);
END;
$$;

CREATE OR REPLACE FUNCTION public.vault_replace_secret(p_secret_id uuid, p_new_secret text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('request.jwt.claims', true) IS NOT NULL
     AND (current_setting('request.jwt.claims', true)::jsonb ->> 'role') IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION 'internal function: service_role only';
  END IF;

  PERFORM vault.update_secret(p_secret_id, new_secret => p_new_secret);
END;
$$;

CREATE OR REPLACE FUNCTION public.vault_delete_secret(secret_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('request.jwt.claims', true) IS NOT NULL
     AND (current_setting('request.jwt.claims', true)::jsonb ->> 'role') IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION 'internal function: service_role only';
  END IF;

  DELETE FROM vault.secrets WHERE id = secret_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.vault_remove_secret(p_secret_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('request.jwt.claims', true) IS NOT NULL
     AND (current_setting('request.jwt.claims', true)::jsonb ->> 'role') IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION 'internal function: service_role only';
  END IF;

  DELETE FROM vault.secrets WHERE id = p_secret_id;
END;
$$;

DO $grant$ BEGIN
  IF to_regprocedure('public.vault_read_secret(uuid)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.vault_read_secret(uuid) TO service_role';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.vault_read_secret(uuid) absente à ce stade du rejeu';
  END IF;
END $grant$;
DO $grant$ BEGIN
  IF to_regprocedure('public.vault_store_secret(text, text, text)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.vault_store_secret(text, text, text) TO service_role';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.vault_store_secret(text, text, text) absente à ce stade du rejeu';
  END IF;
END $grant$;
DO $grant$ BEGIN
  IF to_regprocedure('public.vault_update_secret(uuid, text)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.vault_update_secret(uuid, text) TO service_role';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.vault_update_secret(uuid, text) absente à ce stade du rejeu';
  END IF;
END $grant$;
DO $grant$ BEGIN
  IF to_regprocedure('public.vault_replace_secret(uuid, text)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.vault_replace_secret(uuid, text) TO service_role';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.vault_replace_secret(uuid, text) absente à ce stade du rejeu';
  END IF;
END $grant$;
DO $grant$ BEGIN
  IF to_regprocedure('public.vault_delete_secret(uuid)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.vault_delete_secret(uuid) TO service_role';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.vault_delete_secret(uuid) absente à ce stade du rejeu';
  END IF;
END $grant$;
DO $grant$ BEGIN
  IF to_regprocedure('public.vault_remove_secret(uuid)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.vault_remove_secret(uuid) TO service_role';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.vault_remove_secret(uuid) absente à ce stade du rejeu';
  END IF;
END $grant$;

-- ============================================================
-- 6. cron_dispatch_via_vault — même garde + allowlist des function_path.
--    Un dispatch arbitraire reste un dispatch arbitraire même
--    correctement authentifié (le prompt le note explicitement) :
--    l'allowlist ci-dessous reprend exactement les 4 valeurs utilisées par
--    les jobs cron réels aujourd'hui (20260810000001_fix_dead_cron_jobs_
--    vault_auth.sql, jobid 2/6/7/8). Toute nouvelle valeur nécessite une
--    migration explicite, pas un ajout silencieux.
-- ============================================================
CREATE OR REPLACE FUNCTION public.cron_dispatch_via_vault(function_path text, timeout_ms integer DEFAULT 25000)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $$
DECLARE
  svc_key TEXT;
BEGIN
  IF current_setting('request.jwt.claims', true) IS NOT NULL
     AND (current_setting('request.jwt.claims', true)::jsonb ->> 'role') IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION 'internal function: service_role only';
  END IF;

  IF function_path NOT IN ('refresh-hubspot-tokens', 'sync-hubspot', 'playbook-scheduler', 'self-monitor') THEN
    RAISE EXCEPTION 'cron_dispatch_via_vault: function_path % not in allowlist', function_path;
  END IF;

  SELECT decrypted_secret INTO svc_key
  FROM vault.decrypted_secrets
  WHERE name = 'cron_service_role_key'
  LIMIT 1;

  IF svc_key IS NULL THEN
    RAISE NOTICE '[cron_dispatch_via_vault] Secret Vault cron_service_role_key absent -- % ignoré', function_path;
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/' || function_path,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || svc_key,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := timeout_ms
  );
END;
$$;

DO $grant$ BEGIN
  IF to_regprocedure('public.cron_dispatch_via_vault(text, integer)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.cron_dispatch_via_vault(text, integer) TO service_role';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.cron_dispatch_via_vault(text, integer) absente à ce stade du rejeu';
  END IF;
END $grant$;

-- ============================================================
-- 7. increment_webhook_failure / mark_playbook_executed / seed_default_playbooks
--    Prennent un org_id/run_id en paramètre sans aucune vérification
--    d'identité dans le corps d'origine — la garde ci-dessous couvre ce
--    trou, le GRANT service_role-only couvre le reste.
--    seed_default_playbooks gagne en plus une garde d'idempotence
--    défensive (Lot 1.3) : n'insère rien si l'org cible a déjà des
--    playbooks, quelle que soit l'origine de l'appel.
-- ============================================================

CREATE OR REPLACE FUNCTION public.increment_webhook_failure(p_org_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_failure_count integer;
BEGIN
  IF current_setting('request.jwt.claims', true) IS NOT NULL
     AND (current_setting('request.jwt.claims', true)::jsonb ->> 'role') IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION 'internal function: service_role only';
  END IF;

  UPDATE webhook_configs
  SET failure_count = failure_count + 1,
      updated_at = now()
  WHERE organization_id = p_org_id
    AND provider = 'webhook'
  RETURNING failure_count INTO v_failure_count;

  RETURN v_failure_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_playbook_executed(p_run_id uuid, p_organization_id uuid, p_executed_by uuid DEFAULT NULL::uuid)
RETURNS TABLE(updated boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated_count INTEGER;
BEGIN
  IF current_setting('request.jwt.claims', true) IS NOT NULL
     AND (current_setting('request.jwt.claims', true)::jsonb ->> 'role') IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION 'internal function: service_role only';
  END IF;

  UPDATE public.playbook_runs
  SET status = 'executed',
      executed_at = NOW(),
      executed_by = p_executed_by
  WHERE id = p_run_id
    AND organization_id = p_organization_id
    AND status = 'exported';

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  RETURN QUERY SELECT (v_updated_count > 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.seed_default_playbooks(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('request.jwt.claims', true) IS NOT NULL
     AND (current_setting('request.jwt.claims', true)::jsonb ->> 'role') IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION 'internal function: service_role only';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_org_id) THEN
    RAISE EXCEPTION 'seed_default_playbooks: organization % does not exist', p_org_id;
  END IF;

  IF EXISTS (SELECT 1 FROM public.playbooks WHERE organization_id = p_org_id) THEN
    RAISE NOTICE '[seed_default_playbooks] org % already has playbooks, skipping', p_org_id;
    RETURN;
  END IF;

  -- 1. Prévention churn — Comptes enterprise (churn_risk >= 70, plan growth/enterprise, MRR >= 500€)
  INSERT INTO public.playbooks (organization_id, title, description, playbook_type, template_category, actions, eligibility_criteria, status, priority, source, is_automated, is_template)
  VALUES (p_org_id,
    'Prévention churn — Comptes enterprise',
    'Playbook de rétention ciblant les comptes enterprise à haut risque de churn. Déclenche une alerte Slack, crée une tâche de suivi et marque le compte pour revue.',
    'semi_automated', 'churn_prevention',
    '[{"type": "slack_notify", "order": 1, "config": {"channel": "#cs-critical", "template": "churn_alert_enterprise"}}, {"type": "create_task", "order": 2, "config": {"title": "Appel de rétention urgent", "due_days": 2}}, {"type": "assign_owner", "order": 3, "config": {"role": "csm_senior"}}, {"type": "flag_for_review", "order": 4, "config": {}}]'::jsonb,
    '{"operator": "AND", "conditions": [{"field": "churn_risk_score", "value": 70, "operator": "gte"}, {"field": "plan_tier", "value": ["growth", "enterprise"], "operator": "in"}, {"field": "mrr_cents", "value": 50000, "operator": "gte"}]}'::jsonb,
    'draft', 'critical', 'system', false, true);

  -- 2. Relance comptes inactifs (usage <= 20, health <= 40)
  INSERT INTO public.playbooks (organization_id, title, description, playbook_type, template_category, actions, eligibility_criteria, status, priority, source, is_automated, is_template)
  VALUES (p_org_id,
    'Relance comptes inactifs',
    'Cible les comptes avec un score d''usage faible. Envoie une notification et planifie une session de redécouverte produit.',
    'automated', 'reactivation',
    '[{"type": "slack_notify", "order": 1, "config": {"channel": "#cs-team", "template": "inactive_account"}}, {"type": "create_task", "order": 2, "config": {"title": "Planifier démo re-onboarding", "due_days": 5}}, {"type": "log_note", "order": 3, "config": {"note": "Compte détecté comme inactif — relance automatique déclenchée"}}]'::jsonb,
    '{"operator": "AND", "conditions": [{"field": "product_usage_score", "value": 20, "operator": "lte"}, {"field": "health_score", "value": 40, "operator": "lte"}]}'::jsonb,
    'draft', 'high', 'system', true, true);

  -- 3. Détection opportunité d'expansion (expansion >= 70, health >= 60)
  INSERT INTO public.playbooks (organization_id, title, description, playbook_type, template_category, actions, eligibility_criteria, status, priority, source, is_automated, is_template)
  VALUES (p_org_id,
    'Détection opportunité d''expansion',
    'Identifie les comptes avec une utilisation élevée des sièges et un bon score de santé. Crée une opportunité d''upsell.',
    'semi_automated', 'expansion',
    '[{"type": "slack_notify", "order": 1, "config": {"channel": "#sales-expansion", "template": "expansion_opportunity"}}, {"type": "create_task", "order": 2, "config": {"title": "Préparer proposition d''upgrade", "due_days": 7}}, {"type": "update_tag", "order": 3, "config": {"tag": "expansion_candidate"}}]'::jsonb,
    '{"operator": "AND", "conditions": [{"field": "expansion_score", "value": 70, "operator": "gte"}, {"field": "health_score", "value": 60, "operator": "gte"}]}'::jsonb,
    'draft', 'medium', 'system', false, true);

  -- 4. Onboarding nouveaux comptes (health <= 50) — template_category = NULL
  -- (correctif 20260809000001) — 'onboarding' n'est pas une catégorie V1
  -- valide, NULL est explicitement autorisé, pas un contournement.
  INSERT INTO public.playbooks (organization_id, title, description, playbook_type, template_category, actions, eligibility_criteria, status, priority, source, is_automated, is_template)
  VALUES (p_org_id,
    'Onboarding nouveaux comptes',
    'Accompagnement des comptes créés depuis moins de 30 jours. Assigne un CSM, planifie un check-in et envoie un welcome Slack.',
    'automated', NULL,
    '[{"type": "assign_owner", "order": 1, "config": {"role": "csm"}}, {"type": "slack_notify", "order": 2, "config": {"channel": "#cs-onboarding", "template": "new_account_welcome"}}, {"type": "create_task", "order": 3, "config": {"title": "Premier check-in onboarding", "due_days": 3}}, {"type": "schedule_review", "order": 4, "config": {"review_days": 14}}]'::jsonb,
    '{"operator": "AND", "conditions": [{"field": "health_score", "value": 50, "operator": "lte"}]}'::jsonb,
    'draft', 'high', 'system', true, true);

  -- 5. Suivi renouvellement contrat (MRR >= 300€)
  INSERT INTO public.playbooks (organization_id, title, description, playbook_type, template_category, actions, eligibility_criteria, status, priority, source, is_automated, is_template)
  VALUES (p_org_id,
    'Suivi renouvellement contrat',
    'Alerte 60 jours avant l''échéance du contrat. Prépare le dossier de renouvellement et planifie une réunion.',
    'semi_automated', 'renewal',
    '[{"type": "slack_notify", "order": 1, "config": {"channel": "#cs-renewals", "template": "renewal_upcoming"}}, {"type": "create_task", "order": 2, "config": {"title": "Préparer dossier de renouvellement", "due_days": 14}}, {"type": "create_task", "order": 3, "config": {"title": "Planifier réunion de renouvellement", "due_days": 7}}, {"type": "flag_for_review", "order": 4, "config": {}}]'::jsonb,
    '{"operator": "AND", "conditions": [{"field": "mrr_cents", "value": 30000, "operator": "gte"}]}'::jsonb,
    'draft', 'high', 'system', false, true);

  -- 6. Récupération comptes perdus (churn_risk >= 90) — template_category =
  -- NULL (correctif 20260809000001), même raison que le playbook 4.
  INSERT INTO public.playbooks (organization_id, title, description, playbook_type, template_category, actions, eligibility_criteria, status, priority, source, is_automated, is_template)
  VALUES (p_org_id,
    'Récupération comptes perdus',
    'Cible les comptes récemment désabonnés avec un MRR significatif. Déclenche une campagne de winback.',
    'manual', NULL,
    '[{"type": "slack_notify", "order": 1, "config": {"channel": "#cs-winback", "template": "winback_campaign"}}, {"type": "assign_owner", "order": 2, "config": {"role": "account_executive"}}, {"type": "create_task", "order": 3, "config": {"title": "Appel winback — proposer offre spéciale", "due_days": 3}}, {"type": "log_note", "order": 4, "config": {"note": "Compte en churn — campagne de récupération déclenchée"}}]'::jsonb,
    '{"operator": "AND", "conditions": [{"field": "churn_risk_score", "value": 90, "operator": "gte"}]}'::jsonb,
    'draft', 'medium', 'system', false, true);

  -- 7. Alerte churn risque élevé (churn_risk >= 70)
  INSERT INTO public.playbooks (organization_id, title, description, playbook_type, template_category, actions, eligibility_criteria, status, priority, source, is_automated, is_template)
  VALUES (p_org_id,
    'Alerte churn risque élevé',
    'Notification automatique quand un compte dépasse 70% de risque de churn. Actif en continu.',
    'automated', 'churn_prevention',
    '[{"type": "slack_notify", "order": 1, "config": {"channel": "#cs-alerts", "template": "high_churn_risk"}}, {"type": "create_task", "order": 2, "config": {"title": "Intervention urgente — risque de churn", "due_days": 1}}, {"type": "flag_for_review", "order": 3, "config": {}}]'::jsonb,
    '{"operator": "AND", "conditions": [{"field": "churn_risk_score", "value": 70, "operator": "gte"}]}'::jsonb,
    'draft', 'critical', 'system', true, true);

  -- 8. Suivi santé comptes growth (health <= 50, plan growth)
  INSERT INTO public.playbooks (organization_id, title, description, playbook_type, template_category, actions, eligibility_criteria, status, priority, source, is_automated, is_template)
  VALUES (p_org_id,
    'Suivi santé comptes growth',
    'Revue hebdomadaire des comptes growth avec un health score en baisse.',
    'semi_automated', 'churn_prevention',
    '[{"type": "slack_notify", "order": 1, "config": {"channel": "#cs-team", "template": "health_drop_alert"}}, {"type": "create_task", "order": 2, "config": {"title": "Revue santé compte — analyser causes", "due_days": 3}}, {"type": "schedule_review", "order": 3, "config": {"review_days": 7}}]'::jsonb,
    '{"operator": "AND", "conditions": [{"field": "health_score", "value": 50, "operator": "lte"}, {"field": "plan_tier", "value": "growth", "operator": "eq"}]}'::jsonb,
    'draft', 'high', 'system', true, true);

  -- 9. Upsell sièges — comptes saturés (expansion >= 65, health >= 55)
  INSERT INTO public.playbooks (organization_id, title, description, playbook_type, template_category, actions, eligibility_criteria, status, priority, source, is_automated, is_template)
  VALUES (p_org_id,
    'Upsell sièges — comptes saturés',
    'Détecte les comptes utilisant plus de 80% de leurs sièges disponibles.',
    'manual', 'expansion',
    '[{"type": "slack_notify", "order": 1, "config": {"channel": "#sales-expansion", "template": "seat_saturation"}}, {"type": "create_task", "order": 2, "config": {"title": "Contacter pour upgrade plan sièges", "due_days": 5}}, {"type": "update_tag", "order": 3, "config": {"tag": "seat_upgrade_opportunity"}}]'::jsonb,
    '{"operator": "AND", "conditions": [{"field": "expansion_score", "value": 65, "operator": "gte"}, {"field": "health_score", "value": 55, "operator": "gte"}]}'::jsonb,
    'draft', 'medium', 'system', false, true);
END;
$$;

DO $grant$ BEGIN
  IF to_regprocedure('public.increment_webhook_failure(uuid)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.increment_webhook_failure(uuid) TO service_role';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.increment_webhook_failure(uuid) absente à ce stade du rejeu';
  END IF;
END $grant$;
DO $grant$ BEGIN
  IF to_regprocedure('public.mark_playbook_executed(uuid, uuid, uuid)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.mark_playbook_executed(uuid, uuid, uuid) TO service_role';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.mark_playbook_executed(uuid, uuid, uuid) absente à ce stade du rejeu';
  END IF;
END $grant$;
DO $grant$ BEGIN
  IF to_regprocedure('public.seed_default_playbooks(uuid)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.seed_default_playbooks(uuid) TO service_role';
  ELSE
    RAISE NOTICE 'GRANT ignoré : public.seed_default_playbooks(uuid) absente à ce stade du rejeu';
  END IF;
END $grant$;

-- ============================================================
-- 8. on_playbook_activate — retire la clé service_role en clair, lit
--    depuis Vault au moment de l'appel (même secret que
--    cron_dispatch_via_vault : cron_service_role_key). Les 3 migrations
--    historiques (20260531000001/3/5) qui committent le littéral en clair
--    ne sont volontairement PAS modifiées (idempotence/historique git —
--    voir garde CI ci-dessous pour la couverture anti-régression future).
--    Dégradation gracieuse identique à cron_dispatch_via_vault : no-op si
--    le secret Vault est absent, plutôt qu'un échec bruyant.
-- ============================================================
CREATE OR REPLACE FUNCTION public.on_playbook_activate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $$
DECLARE
  svc_key TEXT;
BEGIN
  IF NEW.status = 'active' AND (OLD.status IS DISTINCT FROM 'active') THEN

    IF NEW.segment_id IS NULL THEN
      RAISE NOTICE '[playbook_activate_trigger] Playbook % sans segment_id — exécution manuelle requise', NEW.id;
      RETURN NEW;
    END IF;

    SELECT decrypted_secret INTO svc_key
    FROM vault.decrypted_secrets
    WHERE name = 'cron_service_role_key'
    LIMIT 1;

    IF svc_key IS NULL THEN
      RAISE NOTICE '[playbook_activate_trigger] Secret Vault cron_service_role_key absent — playbook-execute non déclenché pour %', NEW.id;
      RETURN NEW;
    END IF;

    PERFORM net.http_post(
      'https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/playbook-execute',
      jsonb_build_object(
        'playbook_id',      NEW.id,
        'organization_id',  NEW.organization_id,
        'segment_id',       NEW.segment_id,
        'execution_source', 'manual'
      ),
      '{}'::jsonb,
      jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || svc_key
      ),
      5000
    );

    RAISE NOTICE '[playbook_activate_trigger] playbook-execute déclenché pour playbook % (org: %, segment: %)',
      NEW.id, NEW.organization_id, NEW.segment_id;
  END IF;

  RETURN NEW;
END;
$$;
