-- Migration: Ajouter mrr_recovered_cents et mrr_expansion_cents sur playbook_executions
-- Nécessaire pour le suivi MRR par exécution (utilisé par get_playbook_full_detail)

ALTER TABLE public.playbook_executions
  ADD COLUMN IF NOT EXISTS mrr_recovered_cents INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.playbook_executions
  ADD COLUMN IF NOT EXISTS mrr_expansion_cents INTEGER NOT NULL DEFAULT 0;
