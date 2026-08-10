-- ============================================================
-- Playbook Outcome Tracking (chantier C) — lien traçable (US3, T022)
-- Destination de redirection configurée par playbook, jamais par le
-- visiteur du lien — cf. contracts/playbook-outcome-api.md.
-- ============================================================

ALTER TABLE playbooks
  ADD COLUMN IF NOT EXISTS link_redirect_url TEXT NULL;
