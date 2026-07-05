-- ============================================================
-- Refonte playbooks V1
--
-- 1. Archiver les anciens templates (is_template → FALSE, status → archived)
--    template_category mis à NULL pour éviter la violation du nouveau CHECK
--    sur les valeurs hors-V1 (ex: 'health_monitoring', 'winback', 'onboarding').
-- 2. Aligner le CHECK template_category sur les catégories V1.
-- 3. Corriger le playbook live UUID 74b20a56 : hubspot_create_task → send_email.
--
-- NOTE : l'insertion des 6 nouveaux templates (étape 3.4) est suspendue.
--   Raison : organization_id NOT NULL sur playbooks, aucune organisation
--   système disponible dans les migrations. Attente d'une décision
--   architecturale sur la gestion des templates globaux.
-- ============================================================

-- ── 1. Archiver les anciens templates ────────────────────────
-- template_category = NULL pour passer le nouveau CHECK sans exception.
UPDATE public.playbooks
SET
  is_template       = FALSE,
  status            = 'archived',
  template_category = NULL,
  updated_at        = NOW()
WHERE is_template = TRUE;

-- ── 2. Aligner le CHECK template_category sur les catégories V1 ──
ALTER TABLE public.playbooks
  DROP CONSTRAINT IF EXISTS playbooks_template_category_check;

ALTER TABLE public.playbooks
  ADD CONSTRAINT playbooks_template_category_check CHECK (
    template_category IN (
      'churn_prevention',
      'expansion',
      'renewal',
      'payment_recovery',
      'reactivation'
      -- V2 : 'onboarding', 'winback', 'health_monitoring', 'customer_education',
      --       'nps_detractors', 'champions_advocacy', 'downgrade_prevention', 'success_planning'
    ) OR template_category IS NULL
  );

-- ── 3. Corriger le playbook live UUID 74b20a56 ───────────────
-- Remplacement hubspot_create_task → send_email pour éviter un crash
-- à la prochaine exécution (hubspot_create_task n'est plus dans VALID_ACTION_TYPES).
-- Si le playbook n'existe pas, UPDATE affecte 0 lignes (idempotent).
UPDATE public.playbooks
SET
  actions    = '[{
    "type": "send_email",
    "order": 1,
    "config": {
      "email_subject": "🚀 Opportunité d expansion détectée — {{account_name}}",
      "email_body_html": "<p>Sentio AI a détecté une opportunité d expansion sur le compte <strong>{{account_name}}</strong>.</p><p>Score de santé : {{health_score}} | MRR : {{mrr}}</p><p>Consultez le compte dans Sentio AI pour agir.</p>"
    }
  }]'::jsonb,
  updated_at = NOW()
WHERE id = '74b20a56-4a55-4d84-9a17-ce6cc1a64459';
