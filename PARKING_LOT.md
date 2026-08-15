# Parking lot

Découvertes faites en cours de chantier et **volontairement non traitées** sur
le moment, pour ne pas dériver. Une ligne datée par découverte. Ce fichier
n'est pas un backlog priorisé — c'est un endroit où poser ce qu'on a vu sans
s'arrêter.

## Lot 8 — rapatriement des 9 Edge Functions hors git (2026-08-15)

- 2026-08-15 — `export-playbook-accounts` porte la dette devise `mrr_euros` (colonne CSV) + suffixe `E` littéral dans le message Slack. Corrigeable maintenant que le code est sous contrôle de version. Non corrigé ici : le rapatriement est explicitement « à l'identique, aucune amélioration ».
- 2026-08-15 — Contenu utilisateur en français dans plusieurs des 9 fonctions rapatriées (`export-playbook-accounts` : `Revue manuelle recommandee`, libellés `formatActionType` ; `export-segment-csv` : messages d'erreur ; `webhook-config` : tous les messages) alors que la décision produit actée est English-only (en-US). Même raison de non-correction.
- 2026-08-15 — `_shared/translations.ts` (dictionnaire FR/EN complet) et les fonctions `org-settings`/`get-organization-locale`/`update-organization-locale` implémentent une plomberie multi-langue que `CLAUDE.md` déclare pourtant inexistante (« aucune plomberie multi-langue côté backend »). Rapatriées telles quelles parce qu'elles sont live ; la question « à supprimer ou à assumer ? » est une décision produit, pas un arbitrage de rapatriement.
- 2026-08-15 — `export-segment-csv` est déployé avec `verify_jwt = true` alors que son code appelle `verifyUserAuth` (JWT ES256). D'après l'en-tête de `_shared/auth.ts`, `verify_jwt=true` rejette les ES256 — cette fonction est donc probablement inutilisable en l'état depuis le navigateur. Valeur reproduite à l'identique dans `config.toml` (rapatriement fidèle) ; à vérifier et trancher séparément.
- 2026-08-15 — `_shared/slack-alert.ts` a divergé : la version live embarquée avec `integration-oauth` (mars 2026) exporte en plus `alertSlackWithToken` et `alertSlackBatch` (+ un module `slack-batch-helpers.ts`), absents du repo. Aucun appelant dans le repo, donc aucune casse — mais deux versions du même module coexistent, l'une seulement en production.
- 2026-08-15 — `export-segment-csv`/`SEGMENT_FILTERS` (`_shared/segment-export-helpers.ts`) réimplémente une segmentation en mémoire alignée sur `determineSegmentTypes` **V1** (`health >= 80`, `mrr = 0` → `en_churn`…), moteur supprimé du repo le 2026-08-02 et remplacé par V3. Cet export produit donc des segments qui ne correspondent plus à ceux affichés ailleurs dans le produit.
- 2026-08-15 — `_shared/segment-export-helpers.ts::SegmentAccountRow` déclare `data_source: string | null`, jamais renseigné par les deux constructions d'objet de `export-segment-csv/index.ts`. Incohérence de type présente dans le code live.

## Divers

- 2026-08-15 — `_shared/mrr-engine.test-fixtures.ts` importe `./mrr-engine` sans extension `.ts` (résolution Node/Vitest). Pré-existant, sans effet sur le déploiement Deno (le fichier n'est pas importé par une Edge Function), mais c'est la seule entorse à la convention d'import du dossier.
