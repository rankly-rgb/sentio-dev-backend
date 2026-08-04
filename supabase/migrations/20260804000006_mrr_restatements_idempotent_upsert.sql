-- ============================================================
-- mrr_restatements — upsert idempotent par (account_id, reason)
--
-- Trouvé lors de l'auto-vérification adversariale du restatement_mode
-- (2026-08-04, IMPLEMENTATION_LOG.md) : sync-stripe/index.ts écrivait déjà
-- `mrr_restatements` via `.upsert(rows, { onConflict: 'id' })`, mais aucune
-- ligne construite ne porte jamais de champ `id` (colonne à
-- DEFAULT gen_random_uuid(), jamais fournie par l'appelant) — cet upsert
-- ne pouvait donc jamais matcher une ligne existante, se comportant comme
-- un simple INSERT à chaque appel.
--
-- Combiné à un run interrompu à mi-course (accounts.mrr_cents déjà
-- restaté pour un batch de 500 comptes, mrr_restatements pas encore
-- écrit pour ce même batch) puis rejoué par l'opérateur : le rejeu relit
-- `accounts.mrr_cents` (déjà la nouvelle valeur) comme "previous", calcule
-- le même "new" depuis Stripe, ne détecte plus aucun delta pour ces
-- comptes — et ne les journalise donc JAMAIS dans mrr_restatements. La
-- requête de vérification du RUNBOOK ("orgs avec les plus gros deltas")
-- sous-compte alors silencieusement les comptes affectés par ce chantier
-- pour l'org concernée, sans aucune erreur visible.
--
-- Contrainte unique (account_id, reason) : un seul row de restatement par
-- compte et par raison de migration — un vrai upsert redevient possible,
-- rejouable sans perte ni doublon quel que soit le point d'interruption
-- (voir aussi le réordonnancement des écritures dans sync-stripe/index.ts,
-- qui écrit désormais mrr_restatements AVANT accounts pour ce même motif).
-- ============================================================

ALTER TABLE public.mrr_restatements
  DROP CONSTRAINT IF EXISTS mrr_restatements_account_reason_unique;

ALTER TABLE public.mrr_restatements
  ADD CONSTRAINT mrr_restatements_account_reason_unique UNIQUE (account_id, reason);
