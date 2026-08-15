# Parking lot

Découvertes faites en cours de chantier et **volontairement non traitées** sur
le moment, pour ne pas dériver. Une ligne datée par découverte. Ce fichier
n'est pas un backlog priorisé — c'est un endroit où poser ce qu'on a vu sans
s'arrêter.

- 2026-08-15 — `export-playbook-accounts` (rapatrié à l'identique, Lot 8) porte la dette devise `mrr_euros` (colonne CSV) + suffixe `E` littéral dans le message Slack. Corrigeable maintenant que le code est sous contrôle de version. Non corrigé ici : le rapatriement est explicitement « à l'identique, aucune amélioration ».
- 2026-08-15 — `export-playbook-accounts` : contenu utilisateur en français (`Revue manuelle recommandee`, `Invoice impayee depuis Xj`, libellés `formatActionType`, `hubspot_import_note`) alors que la décision produit actée est English-only (en-US). Même raison de non-correction.
- 2026-08-15 — Table `playbook_exports` et RPC `get_playbook_export_summary` : absentes des migrations versionnées (`grep` sur `supabase/migrations/`) alors qu'elles existent en base. À déclarer en migration idempotente — traité dans le cadre de la preuve de fin d'étape 0 (`db diff` vide) si le diff les remonte.
