-- Migration : Zero-PII — suppression colonnes PII de email_send_log
-- email_to et email_subject stockaient l'email du CSM Sentio (utilisateur interne)
-- de façon persistante. Ces colonnes ne sont lues nulle part (ni frontend ni fonction).
-- L'audit trail reste complet via execution_id, account_id, playbook_id, step_order,
-- email_status et error_message.

ALTER TABLE public.email_send_log
  DROP COLUMN IF EXISTS email_to,
  DROP COLUMN IF EXISTS email_subject;
