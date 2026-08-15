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

## Dérive base de données trouvée pendant le Lot 8 (2026-08-15)

- 2026-08-15 — `public.handle_new_user()` existe en base, est référencée par la matrice du Lot 1, mais **n'est rattachée à aucun trigger** (`pg_trigger` vérifié, ni sur `auth.users` ni ailleurs). La fonction active est `handle_new_user_signup` (déclarée, elle, dans `20260503000004`). Deux implémentations proches d'un même besoin, dont une morte. Capturée telle quelle par `20260815000003` ; savoir laquelle garder est une décision produit.
- 2026-08-15 — `public.account_notes` (1602 lignes) n'était déclarée dans aucune migration. Ses deux FK portent le suffixe `_fk` là où tout le reste du schéma utilise `_fkey` — reproduit à l'identique pour ne pas créer de faux diff, mais c'est une incohérence de nommage.
- 2026-08-15 — Inventaire complet fait à cette occasion : 74 objets `public` (tables/vues/fonctions) + 36 triggers. Après les migrations `20260815000002`/`20260815000003`, tout est déclaré. Ce recensement n'a **pas** couvert : politiques RLS des tables déjà déclarées, contraintes ajoutées hors migration sur des tables déjà déclarées, colonnes ajoutées hors migration, index hors migration, jobs `cron.job`. Un `supabase db diff --linked` réel reste le seul contrôle exhaustif.

## Dérive de configuration (2026-08-15, relevée par `supabase link`)

- 2026-08-15 — `supabase link` signale `Local config differs from linked project` : `supabase/config.toml` déclare `[db] major_version = 15` alors que le projet tourne en **17**, et toute sa section `[auth]` décrit un environnement local (`site_url = http://127.0.0.1:3000`, MFA TOTP off, `enable_confirmations = false`, `max_frequency = 1s`, `otp_length = 6`) là où la production a `https://app.sentioapp.io`, MFA TOTP on, confirmations on, `1m0s`, `otp_length = 8`. Sans effet aujourd'hui — aucun workflow n'exécute `supabase config push`, et `db push`/`functions deploy` ne poussent pas cette config. Mais `config.toml` n'est donc pas la source de vérité des réglages auth, et le jour où quelqu'un lance `config push` « pour synchroniser », il désactive la MFA et les confirmations email en production. Les blocs `[functions.*]` du même fichier sont, eux, bien consommés par `functions deploy` (c'est ce qui porte `verify_jwt`).
