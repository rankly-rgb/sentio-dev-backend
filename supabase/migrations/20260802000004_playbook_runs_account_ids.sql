-- Ajoute la liste des comptes couverts par un run, nécessaire pour
-- l'anti-double-relance (A7a) : sans cette liste, playbook_runs ne
-- pourrait exclure que "playbook déjà exporté récemment" au global,
-- pas "ces comptes précis ont déjà reçu un envoi confirmé".
--
-- Array plutôt qu'une table de jonction playbook_run_accounts : borné à
-- MAX_ACCOUNTS_PER_RUN (200) par run, pas de besoin de requêter par
-- compte individuellement en dehors de ce cas d'usage — une table de
-- jonction serait une abstraction non justifiée pour ce volume (voir
-- CLAUDE.md, anti-surengineering).

ALTER TABLE public.playbook_runs
  ADD COLUMN IF NOT EXISTS account_ids UUID[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_playbook_runs_account_ids
  ON public.playbook_runs USING GIN (account_ids);
