-- Mise à jour du corps de la tâche HubSpot pour le playbook "Détection opportunité d'expansion"
-- Inclut les nouvelles variables : {{segment_name}}, {{today}}, {{account_id}}
UPDATE public.playbooks
SET
  actions = '[
    {
      "type": "hubspot_create_task",
      "order": 1,
      "config": {
        "task_body": "Compte détecté par Sentio AI — action requise.\n\nCompte : {{display_name}}\nScore de santé : {{health_score}}/100\nRisque de churn : {{churn_risk_score}}/100\nMRR : {{mrr_euros}} €\n\nSegment : {{segment_name}}\nDétecté le : {{today}}\n\n→ Consulter le compte dans Sentio : https://app.sentioapp.io/dashboard/accounts/{{account_id}}",
        "priority": "HIGH"
      }
    }
  ]'::jsonb,
  updated_at = NOW()
WHERE id = '74b20a56-4a55-4d84-9a17-ce6cc1a64459';
