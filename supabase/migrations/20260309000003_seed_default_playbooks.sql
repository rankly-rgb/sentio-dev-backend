-- ============================================================
-- Migration : Seed default playbooks on organization creation
-- Trigger AFTER INSERT on organizations → creates 9 template playbooks
-- Covers: churn prevention, reactivation, expansion, onboarding,
--         renewal, winback, health monitoring, seat upsell
-- ============================================================

-- ------------------------------------------------------------
-- 1. Function: seed_default_playbooks(org_id)
-- Creates 9 scoring-based playbooks covering all key segments
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.seed_default_playbooks(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  INSERT INTO public.playbooks (organization_id, title, description, playbook_type, template_category, actions, eligibility_criteria, status, priority, source, is_automated, is_template)
  VALUES (p_org_id,
    'Onboarding nouveaux comptes',
    'Accompagnement des comptes créés depuis moins de 30 jours. Assigne un CSM, planifie un check-in et envoie un welcome Slack.',
    'automated', 'onboarding',
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
  INSERT INTO public.playbooks (organization_id, title, description, playbook_type, template_category, actions, eligibility_criteria, status, priority, source, is_automated, is_template)
  VALUES (p_org_id,
    'Récupération comptes perdus',
    'Cible les comptes récemment désabonnés avec un MRR significatif. Déclenche une campagne de winback.',
    'manual', 'winback',
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

-- ------------------------------------------------------------
-- 2. Trigger on organizations — auto-seed playbooks
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.on_organization_created()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.seed_default_playbooks(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS seed_playbooks_on_org_created ON public.organizations;
CREATE TRIGGER seed_playbooks_on_org_created
  AFTER INSERT ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.on_organization_created();

-- ------------------------------------------------------------
-- 3. Backfill: seed playbooks for existing orgs without any
-- ------------------------------------------------------------
DO $$
DECLARE
  org_row RECORD;
BEGIN
  FOR org_row IN
    SELECT o.id
    FROM public.organizations o
    LEFT JOIN public.playbooks p ON p.organization_id = o.id
    GROUP BY o.id
    HAVING COUNT(p.id) = 0
  LOOP
    PERFORM public.seed_default_playbooks(org_row.id);
  END LOOP;
END;
$$;
