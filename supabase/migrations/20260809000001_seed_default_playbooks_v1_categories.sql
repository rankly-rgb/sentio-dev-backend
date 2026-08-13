-- ============================================================
-- Fix : seed_default_playbooks() bloque toute création d'organisation
-- depuis le 2026-06-14
--
-- Root cause : 20260614000002_refonte_playbooks_v1.sql a resserré
-- playbooks_template_category_check au set V1 (churn_prevention,
-- expansion, renewal, payment_recovery, reactivation, ou NULL) et a
-- correctement réconcilié les lignes EXISTANTES à ce moment-là
-- (`UPDATE ... SET template_category = NULL WHERE is_template = TRUE`).
-- Mais seed_default_playbooks(uuid) — la fonction appelée par le trigger
-- `seed_playbooks_on_org_created` (AFTER INSERT ON organizations, donc
-- déclenchée à CHAQUE création d'org, y compris via le trigger de signup
-- handle_new_user_signup(), 20260503000004_signup_trigger_and_trial.sql)
-- — n'est versionnée dans AUCUNE migration (créée hors bande, même statut
-- que vault_create_secret/vault_read_secret, cf. commentaire de
-- 20260802000008_stripe_connection_vault_rpcs.sql). Elle continue
-- d'insérer 2 des 9 playbooks par défaut avec template_category =
-- 'onboarding' / 'winback' — les deux valeurs explicitement nommées "V2,
-- pas encore construites" dans le commentaire de la migration qui a
-- resserré la contrainte (ligne 6 et 38 de 20260614000002).
--
-- Impact réel : toute organisation créée depuis le 2026-06-14 échoue sur
-- ce CHECK (confirmé par reproduction directe le 2026-08-09 : les 11 orgs
-- et les 3 auth.users de ce projet dev datent tous d'avant le 2026-06-14,
-- zéro depuis). L'échec du trigger fait échouer toute la transaction
-- englobante, y compris un signup réel via auth.users.
--
-- Correctif : template_category = NULL pour ces deux playbooks (déjà une
-- valeur explicitement autorisée par la contrainte, pas un contournement
-- — honnête : aucune catégorie V1 ne correspond). Titre, description,
-- eligibility_criteria, actions inchangés. La contrainte
-- playbooks_template_category_check elle-même n'est pas modifiée.
--
-- CREATE OR REPLACE, même signature exacte (p_org_id uuid) que la version
-- hors-bande actuelle — verifié via pg_get_functiondef avant d'écrire
-- cette migration, pour éviter la collision "cannot change name of input
-- parameter" déjà rencontrée sur les RPC Vault (SQLSTATE 42P13, cf.
-- 20260802000008_stripe_connection_vault_rpcs.sql).
-- ============================================================

CREATE OR REPLACE FUNCTION public.seed_default_playbooks(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
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

  -- 4. Onboarding nouveaux comptes (health <= 50)
  -- template_category = NULL (correctif 20260809000001) — 'onboarding' n'est
  -- pas une catégorie V1 valide (playbooks_template_category_check,
  -- 20260614000002). NULL est explicitement autorisé, pas un contournement.
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

  -- 6. Récupération comptes perdus (churn_risk >= 90)
  -- template_category = NULL (correctif 20260809000001) — 'winback' n'est
  -- pas une catégorie V1 valide (playbooks_template_category_check,
  -- 20260614000002). NULL est explicitement autorisé, pas un contournement.
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
$function$;
