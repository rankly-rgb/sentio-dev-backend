-- ============================================================
-- Migration : configurer le playbook "Détection opportunité d'expansion"
-- avec l'action hubspot_create_task et le segment "En expansion"
-- ============================================================

UPDATE public.playbooks
SET
  actions = '[
    {
      "type": "hubspot_create_task",
      "order": 1,
      "config": {
        "task_body": "Compte détecté comme opportunité d''expansion par Sentio AI.\n\nScore de santé : {{health_score}}/100\nMRR actuel : {{mrr_euros}}€\n\nAction recommandée : contacter pour proposer une montée en plan.",
        "priority": "HIGH"
      }
    }
  ]'::jsonb,
  segment_id  = '16a43813-dc28-4167-9329-d5cb6b20e776',
  updated_at  = NOW()
WHERE id = '74b20a56-4a55-4d84-9a17-ce6cc1a64459';
