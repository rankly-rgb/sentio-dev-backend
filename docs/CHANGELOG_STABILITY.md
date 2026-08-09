# Changelog Stabilité — Sentio AI SaaS FR

Historique complet des audits de stabilité et corrections. Extrait du CLAUDE.md le 2026-03-05.

---

## `mrr_movements` — upsert cassé depuis la création de la table, jamais une seule ligne écrite (2026-08-08)

Signalé via un écart Churn Rate affiché à `0.0%` en dashboard — investigation confirmant que `mrr_movements` avait **0 ligne** en base malgré 251 runs `sync-stripe` `completed` depuis mars 2026 (`data_syncs`). Ce n'était pas une absence de churn : `calcChurnRate30d`/`calcNrrPercentage` (`_shared/mrr-engine.ts`) n'ayant jamais eu de mouvements à lire, leur garde-fou `hasAtLeastThreeMonthsOfHistory` se basait sur `organizations.created_at` en l'absence de tout historique réel, produisant un zéro trompeur au lieu d'un statut "indisponible".

**Root cause confirmée par reproduction SQL directe sur la DB dev** : `sync-stripe/index.ts` écrivait via `.upsert(rows, { onConflict: 'organization_id,account_id,movement_date,movement_type' })`. Le seul index unique couvrant ces 4 colonnes est **partiel** (`mrr_movements_sync_idempotency`, migration `20260517000001`, `WHERE stripe_event_id IS NULL`) — Postgres ne peut utiliser un index partiel comme arbitre `ON CONFLICT` que si la requête répète exactement son prédicat `WHERE`, ce que le client PostgREST (`.upsert()`) ne sait pas exprimer. Chaque upsert échouait donc avec `42P10` (aucune contrainte unique ne correspond à la spécification `ON CONFLICT`) — cassé depuis la création de la table (2026-07-05, commits `48dff8e`/`b8a19d9`), jamais un bug de régression.

**Pourquoi invisible** : l'erreur (`mvtErr`) était `console.error`'d puis jetée — jamais poussée dans le tableau `writeErrors` que `DataSyncLogger.complete()` inspecte pour décider du statut final (mécanisme pourtant déjà construit le 2026-08-04 pour exactement cette classe de bug, cf. entrée "Data Integrity" plus bas et le commentaire `WriteError` dans `_shared/data-sync-logger.ts`). `records_failed` n'était pas non plus incrémenté. `sync_status='completed'` était donc écrit sans condition, malgré un échec d'écriture total sur cette table à chaque run.

**Changements (scope : findings #1 et #2 de l'audit ; le chemin `stripe-webhook` et l'index partiel existant ne sont pas touchés)** :
- Migration `20260808000001_mrr_movements_sync_rpc.sql` : nouveau RPC `upsert_mrr_movements_sync(rows JSONB)` exprimant nativement `ON CONFLICT (organization_id, account_id, movement_date, movement_type) WHERE stripe_event_id IS NULL DO NOTHING`, ciblant l'index partiel existant sans le modifier ni en créer un nouveau. `LANGUAGE SQL`, pas de `SECURITY DEFINER` (convention `get_portfolio_snapshot`, 20260712000001 — appelé exclusivement via `service_role`, qui bypass déjà RLS). Un index non-partiel classique (option A envisagée en Phase 0) aurait risqué de faire entrer en collision le chemin `stripe-webhook` (plusieurs mouvements réels légitimes par compte/jour, dédupliqués uniquement par `stripe_event_id`) avec le cap "1 mouvement/jour" voulu côté batch — écarté.
- `_shared/mrr-movements-writer.ts` (nouveau) : `writeMrrMovementsSync()` appelle le RPC et retourne `{ processed, failed, writeError }` — extrait dans son propre module (comme `_shared/cron-lock.ts`/`_shared/data-sync-logger.ts`) pour rester testable en Vitest, `sync-stripe/index.ts` lui-même import des `jsr:` runtime non résolvables par Node. `dedupeMovementRows()` dédoublonne les tuples `(organization_id, account_id, movement_date, movement_type)` en amont de l'écriture — `customerToAccount` (`sync-stripe/index.ts`) est un `Map<stripe_customer_id, account_id>` : deux `stripe_customer_id` distincts pointant vers le même compte (doublon de données historique, cf. commit `4325aa6`) peuvent produire deux lignes identiques dans le même run, avant tout aller-retour DB.
- `sync-stripe/index.ts` : remplace l'`.upsert()` direct par `dedupeMovementRows()` + `writeMrrMovementsSync()` ; `movementsFailed` est désormais ajouté à `records_failed`, et `writeError` poussé dans `writeErrors[]` — `DataSyncLogger.complete()` peut donc enfin dégrader `sync_status` en `completed_with_errors`/`failed` sur ce chemin.

**Hors scope de cette PR (Phase 2, distincte)** : backfill des ~5 mois de `mrr_movements` manquants — un correctif d'écriture seul ne repeuple rien rétroactivement. `restatement_mode` existant n'est pas directement réutilisable (il exclut délibérément toute génération de `mrr_movements`, cf. entrée "Onboarding"/Phase 2.4 plus bas) ; `score_history.mrr_cents` (236k lignes, un snapshot par compte par run `calculate-scores` depuis le 2026-03-02) offre en revanche une source de reconstruction bien plus riche qu'une simple baseline "jour zéro", à exploiter dans ce chantier séparé.

**Tests** : `supabase/tests/mrr-movements-writer.test.ts` (nouveau) — `dedupeMovementRows` (4 cas), `writeMrrMovementsSync` (succès, échec RPC avec code réel `42P10`, code absent → `null`, input vide), et composition avec `DataSyncLogger` prouvant qu'un échec `mrr_movements` seul entraîne `failed` (aucun autre travail dans le run) ou `completed_with_errors` (travail partiel) — jamais `completed` silencieux.

**Non vérifié dans cette PR** : la migration RPC n'a pas été exécutée contre l'instance Postgres dev depuis cette session (écriture de fichier seule, pas d'application directe) — à vérifier au déploiement, comme signalé pour les migrations SQL de l'entrée "Délinquence" ci-dessous.

---

## Délinquence — `is_delinquent` câblé, cinq surfaces "at risk" unifiées (2026-08-06)

Audit délinquence 2026-08-06 (suite de D-NEXT, 2026-08-04) : `accounts.is_delinquent` était écrit correctement par `sync-stripe`/`stripe-webhook` depuis le 2026-08-04 mais **jamais lu** — 164 comptes délinquents sur le portefeuille, tous en bande `low`, tuile Overview « Accounts at risk 0 ». Diagnostic complet (Q1/Q2/Q3) et mesure avant/après dans `IMPLEMENTATION_LOG.md`, Incident #6.

Recherche préalable (demandée par Naima avant tout code) : cinq définitions indépendantes de « à risque » trouvées dans le backend — `churn_risk_band='high'` (`dashboard-api` tuile), `churn_risk_score > 70` (`get_portfolio_snapshot.at_risk_count`, seul consommateur `get-today-status`), `risk >= 70`/`>= 50` (`computePriority`, `get-today-actions`), `health_score <= 30/55` (`accounts_with_priority.priority_label`), `health_score < 40` (`onboarding-first-win`/`onboarding-status`, axe différent, non touché ici). Aucune fusion en une seule définition — les trois premières mesurent des choses réellement différentes (bande de risque, seuil numérique, health score) ; la fusion aurait été une erreur.

**Décision 1 — cumul de signaux** : `is_delinquent` devient le signal churn `payment_delinquent` (35pts, CRITIQUE, `_shared/scoring.ts`), en exclusion mutuelle avec `invoice_overdue_15d` — même fait (paiement en échec) observé à deux précisions différentes ; une fois l'invoice confirmée 15j+, le proxy de statut s'efface au lieu de s'additionner. `payment_failures_90d` reste indépendant. Plafond du cluster de détresse paiement : 95→60pts (au lieu de potentiellement 35+35+25 sur un même compte).

**Décision 2 — segment `impayes`** (`determineSegmentTypesV3`) : élargi de `hasOverdueInvoices` seul à `hasOverdueInvoices || isDelinquent`. `impayes` reste évalué avant `en_danger_critique`/`a_risque_leger` dans la chaîne de priorité (inchangé) — un compte délinquent qui y aurait atterri bascule désormais en `impayes`, délibérément : le libellé est plus actionnable.

**Décision 3 — surfaces d'action, jamais via un seuil numérique conçu pour autre chose** (un compte uniquement délinquent, 35pts, ne franchit jamais `> 70` ou `>= 70` seul) :
- `dashboard-api/index.ts` `handlePortfolioMetrics` : `accounts_at_risk` = `churn_risk_band='high' OR is_delinquent`. Piège anticipé et traité : la majorité des comptes délinquents ont `mrr_status='unavailable'` (`mrr_cents=0`, exclusion de devise minoritaire) — `mrr_at_risk_cents` ne somme que le sous-ensemble réellement chiffrable ; nouveau champ `accounts_at_risk_unpriced` expose le nombre exclu au lieu de laisser un total silencieux se lire comme « rien à risque en argent ».
- Migration `20260806000001_at_risk_includes_delinquent.sql` : `get_portfolio_snapshot.at_risk_count` élargi (`churn_risk_score > 70 OR is_delinquent`) — seul consommateur : `get-today-status`, ratio 30% du statut portefeuille.
- Migration `20260806000002_accounts_priority_delinquent.sql` : `accounts_with_priority.priority_label` gagne une branche `WHEN a.is_delinquent THEN 'critical'`, évaluée après `churned` mais avant les branches `churn_risk_band`/`health_score` existantes — sans ça un compte délinquent aurait pu lire « at risk » sur Overview et un badge plus bas sur sa propre ligne Accounts.
- `get-today-status/index.ts` `selectTopUrgentAccount` : candidats élargis à `churn_risk_score > 70 OR is_delinquent`.
- `_shared/today-actions-helpers.ts` `computePriority` : nouveau paramètre `isDelinquent`, force `P0` en OR direct — « actionnable le jour même » est la raison d'être de ce chantier, un impayé est P0, pas P1. `computeTriggerReasons` ajoute la raison `'Payment past due'`.
- `_shared/playbook-engine.ts` `AccountData` + SELECT `playbook-scheduler` (playbook-execute utilisait déjà `select('*')`) : ajout de `is_delinquent` — sans ce champ, un playbook de dunning est impossible à écrire malgré le signal correctement câblé côté scoring.

**Hors périmètre, explicitement acté** : `delinquent_since` (pas d'horodatage aujourd'hui, un impayé du jour et un impayé de 40 jours scorent identiquement — issue dédiée à ouvrir, migration + emplacement d'écriture à définir) ; couverture de sync des factures (issue #34, distincte, déjà ouverte) ; `p0_insights_count`/`generate-insights` (un impayé devrait à terme générer un insight dédié — issue à ouvrir) ; gabarit de l'email `churn-alert` (générique, ne nomme jamais le signal déclencheur — préexistant, pas aggravé par ce chantier, signalé sans être corrigé).

**Tests** : `scoring-v3.test.ts` (mutual exclusion `payment_delinquent`/`invoice_overdue_15d`, segment `impayes` élargi — 21 nouveaux tests), `get-today-status.test.ts` (+3), `today-actions-helpers.test.ts` (+5), `playbook-engine.test.ts` (+1), `accounts-api.test.ts` (+1). `npm run verify` vert.

**Non validé** : les deux migrations SQL n'ont pas été exécutées contre une instance Postgres locale/live dans cette session (aucun outil Supabase/DB disponible) — à vérifier avant merge. Mesure avant/après portefeuille (164 comptes délinquents, répartition par bande) non repassée après déploiement pour la même raison — voir `IMPLEMENTATION_LOG.md`.

---

## Churn Risk — état figé "churned" pour les comptes partis (2026-08-02, D1/C2.1)

Décision produit D1 (audit rétention 2026-08) : un compte à `mrr_cents = 0` ou dont l'abonnement est `canceled` recevait jusqu'ici un `churn_risk_score` calculé normalement sur ses signaux historiques (factures en retard passées, contraction MRR passée, etc.) — d'où des comptes déjà partis affichés à "92% de risque de churn critique". Un compte parti n'est pas à risque, il est perdu.

**Changements :**
- `calculate-scores/index.ts` (`scoreAccountPure`) : `subscriptionCanceled` calculé avant le scoring churn (au lieu d'après) ; si `mrr_cents === 0 || subscriptionCanceled`, court-circuite entièrement `buildChurnSignals`/`calcChurnRiskV2` — aucun signal n'est évalué. Retourne `{ churn_risk_score: null, churn_risk_band: 'churned', risk_signals_triggered: [], risk_signals_evaluated: 0 }`. `churn_risk_score` reste `NULL` (déjà nullable en base) — pas de clamp à 0, qui se lirait comme "aucun risque" plutôt que "non applicable" (S1 : no data ≠ neutral data).
- `_shared/scoring.ts` : `SegmentInputV3.churnRiskBand` élargi à `'low' | 'watch' | 'high' | 'churned'`. `determineSegmentTypesV3` assignait déjà `en_churn` sur ce même critère (`mrrCents === 0 || subscriptionCanceled`) — les deux sont maintenant réconciliés : un compte du segment `en_churn` porte systématiquement `churn_risk_band = 'churned'`, plus jamais un score/band calculé.
- Migration `20260802000001_churn_risk_band_churned_state.sql` : élargit les CHECK constraints `accounts_churn_risk_band_check` / `score_history_churn_risk_band_check` (`'low'/'watch'/'high'` → `+'churned'`), posées par `20260725000001_scoring_engine_v3.sql`. Sans cette migration, le premier `calculate-scores` écrivant `'churned'` aurait échoué sur la contrainte existante pour tout compte churné.
- `assignSegments` : agrégat `avg_churn_risk` par segment — `churn_risk_score` étant désormais `null` pour les comptes churnés, ajout d'un compteur `churnCount` dédié (même pattern que `healthCount`/`health_score`) pour exclure ces comptes de la moyenne au lieu de les compter comme 0.
- `export-csv/index.ts` : `.order('churn_risk_score', { ascending: false })` → ajout de `nullsFirst: false`. Sans ce changement, un compte churné (`churn_risk_score = null`) serait remonté en tête de tri (comportement par défaut de Postgres : NULL trié en premier en ordre DESC) — soit l'inverse exact de l'objectif de cette décision. Vérifié que les 4 autres endpoints triant par `churn_risk_score` DESC (`churn-alert`, `onboarding-status`, `weekly-digest`, `get-top-churn-risks`) filtrent déjà `churn_risk_band = 'high'` ou `.not('churn_risk_score', 'is', null)` — non affectés.

**Hors scope de ce chantier** (C2.2, séparé) : exclusion explicite des comptes `churned` des KPIs "accounts at risk" / "MRR at risk" agrégés côté `get-today-status`/`dashboard-api`/`accounts-api` — ces endpoints excluent déjà naturellement les comptes à `churn_risk_score IS NULL` de leurs seuils numériques (`> 70` etc., NULL exclu par la sémantique SQL des comparaisons), mais une revue explicite reste à faire pour confirmer qu'aucun comptage n'agrège différemment.

**Tests** : `supabase/tests/calculate-scores-churn.test.ts` (nouveau, 6 tests) — mirror de la décision `isChurned`/état figé, `calculate-scores/index.ts` ne peut pas être importé directement dans Vitest (imports `jsr:`), même convention que `churn-alert.test.ts`.

---

## Devise — retrait des symboles € codés en dur (2026-08-02, E1.2/E1.3 partiel)

Audit préalable (audit rétention 2026-08, décision produit D4 — anglais/en-US intégral) : la conversion FR→EN de l'UI et du contenu généré était déjà faite avant cet audit (aucun toggle FR/EN, `src/i18n/en.ts` seul fichier i18n, aucune chaîne française dans le contenu généré `generate-insights`/`account-summary`). Le seul écart réel trouvé : le symbole `€` codé en dur dans 6 fichiers backend, alors qu'aucune colonne de devise n'existe nulle part dans le schéma (`organizations`/`accounts` n'ont pas de champ `currency` — seules `invoices`/`subscriptions` stockent une devise Stripe par transaction).

**Changements** (symbole `$` par défaut, formatage `en-US` avec séparateurs de milliers ; résolution complète depuis le compte Stripe connecté reste un chantier séparé — aucun champ `currency` org-level n'existe encore pour la porter) :
- `_shared/insight-rules.ts` : `mrrEur` → `mrrUsd`, retourne désormais `$1,234` (le `€` littéral était concaténé séparément à chaque site d'appel)
- `_shared/score-narratives.ts` : `narrativePaymentHealth` (chemin V3 actif) — `€` → `$`. `narrativeFinancial` (V1, zéro appelant — même statut que les fonctions supprimées ci-dessous) non touché, hors scope de ce fix
- `weekly-digest/index.ts` : `formatMrr` retourne `$1,234` ; `accountRow` réutilise `formatMrr` au lieu d'un `Math.round` sans séparateur de milliers (bug de formatage additionnel corrigé au passage)
- `churn-alert/index.ts` : même correction de formatage (séparateurs de milliers + `$`)
- `account-summary/index.ts` : prompt IA — `mrr_euros` renommé `mrr_usd`, `€` → `$` (impacte directement le texte généré par le LLM)
- `export-csv/index.ts` : en-tête CSV `MRR (€)` → `MRR ($)`
- `_shared/connectors/slack.ts` : message Slack sortant (notification playbook vers le Slack du client) — `€` → `$`. Le nom de champ `mrr_eur` du contrat `ConnectorPayload` (payload webhooks sortants Brevo/HubSpot/Mailchimp/etc., documenté dans le changelog "Outbound Webhook System v1") n'est **pas** renommé — c'est un contrat externe déjà documenté, un renommage serait cassant pour des intégrations clientes existantes.

**Non touché intentionnellement** : `stripe-product-mappings-api/index.ts` (déjà correctement conditionné sur `price.currency`, pas un hardcode) ; log d'alerte Slack interne de `sync-stripe` (alerte ops Sentio, pas une sortie produit consommée par l'utilisateur final).

**Tests** : `insight-rules.test.ts`, `churn-alert.test.ts`, `export-csv.test.ts` — assertions `€` → `$` mises à jour.

---

## Playbooks — garde-fou eligibility_criteria vide/absent (2026-08-02, C2.5)

Audit préalable (hypothèse "291/291 comptes ciblés" du rapport d'audit) : `evaluateConditions` (`_shared/playbook-engine.ts`) matchait tous les comptes quand `eligibility_criteria` était `null` ou `{ conditions: [] }`. Confirmé dangereux en pratique dans `playbook-scheduler/index.ts` : quand un playbook n'a **ni** `segment_id` **ni** `eligibility_criteria` significatif, la requête de résolution des comptes (`accountQuery`) ne pose alors aucune autre limite que `MAX_ACCOUNTS_PER_PLAYBOOK` — un playbook automatique mal configuré s'exécutait silencieusement sur la totalité du portefeuille de l'org, sans qu'aucun garde-fou ne s'en aperçoive.

**Changements :**
- `_shared/playbook-engine.ts` : `ConditionGroup` gagne un champ `match_all?: boolean`. `evaluateConditions` ne matche plus rien par défaut pour un groupe `null`/`undefined`/`conditions: []` — seul `match_all: true` explicite restaure ce comportement. `validateConditions` valide et propage ce nouveau champ.
- `playbook-execute/index.ts` : suppression du bypass `playbook.eligibility_criteria ? ... : accounts` sur le chemin **segment_id** (résolution automatique/bulk) — passe désormais toujours par `evaluateConditions`. Le chemin **account_ids** (sélection manuelle explicite, ex. futur "Run this playbook on this account" depuis une carte insight, D2) reste volontairement **non filtré** par eligibility_criteria : une sélection humaine explicite exprime déjà l'intention, la re-filtrer risquerait de ne rien exécuter silencieusement sur le compte pourtant choisi.
- `playbook-scheduler/index.ts` : même suppression du bypass — aucune notion de sélection manuelle ici (100% cron-driven), le garde-fou s'applique donc sans exception.
- Migration `20260802000003_playbook_eligibility_match_all_backfill.sql` : backfill de tous les playbooks existants dont `eligibility_criteria` est `null` ou `conditions: []`, vers un `match_all: true` explicite — préserve exactement leur comportement actuel (rien ne s'arrête de s'exécuter silencieusement suite à ce chantier). Idempotent.
- **Bug latent trouvé au passage** : le template `PLAYBOOK_TEMPLATES_V1['churn-critical-alert']` déclarait `eligibility_criteria: { mrr_cents_min: 1 }` — un raccourci qui n'a jamais été un `ConditionGroup` valide. `playbook-crud handleCreate` contournait `validateConditions` spécifiquement pour les playbooks créés depuis un template (`if (body.from_template_id) { validatedEligibility = body.eligibility_criteria }`), stockant cet objet non conforme tel quel. `evaluateConditions` l'aurait silencieusement traité comme "vide" dans les deux cas (avant ce chantier : matche tout ; après : ne matcherait plus rien, une régression fonctionnelle pour ce template précis). Corrigé : le template déclare désormais un vrai `ConditionGroup` (`mrr_cents > 0`), et le bypass de validation est supprimé — tout eligibility_criteria, template ou non, passe par `validateConditions`.

**Non vérifié dans ce chantier** : la config réelle des playbooks en environnement prod/démo (hypothèse "291/291" du rapport) — aucun accès à une base de données réelle depuis cet environnement de développement. Le correctif de code + la migration de backfill rendent la question sans objet pour l'avenir (le défaut dangereux n'existe plus), mais une vérification a posteriori sur l'historique d'exécution réel resterait utile pour confirmer le diagnostic.

**Tests** : `supabase/tests/playbook-engine.test.ts` — 3 tests existants mis à jour (le défaut n'est plus "matche tout"), 4 nouveaux tests sur `match_all` (évaluation + validation).

---

## Today Actions — source de vérité unique insights + playbooks (2026-08-02, C2.4a)

Audit préalable : la page "Today" affichait deux nombres de deux sources totalement indépendantes sur le même écran — le statut portefeuille (`get-today-status`, basé sur `ai_insights`) et le total "priority actions" (calculé 100% côté client dans `src/lib/types/today-actions.ts`, basé uniquement sur le matching `eligibility_criteria` des playbooks actifs, sans aucune notion d'insight). D'où la contradiction trouvée par l'audit : "portfolio stable" + "0 priority actions" alors que 206 insights critiques étaient actifs — un compte avec un insight critique mais qu'aucun playbook ne ciblait n'apparaissait tout simplement nulle part dans le calcul côté client.

**Changements :**
- `_shared/today-actions-helpers.ts` (nouveau) : port du calcul `today-actions.ts` frontend, avec une différence de fond — `computeTodayActions` inclut désormais un compte s'il matche un playbook actif **OU** s'il porte au moins un insight actif, les deux mécanismes alimentant la même liste dédupliquée par compte. Réutilise `evaluateConditions`/`ConditionGroup` de `_shared/playbook-engine.ts` (déjà existant, zéro nouvelle implémentation du matching). `computePriority` prend désormais aussi en compte la priorité de l'insight le plus urgent du compte (un insight `critical` ne peut jamais laisser un compte en dessous de P0, quels que soient ses scores). `determinePortfolioStatus(criticalInsightCount, totalActions)` formalise la règle non négociable : `criticalInsightCount > 0` ⇒ jamais `'stable'` ; sinon `totalActions > 0` ⇒ `'attention_needed'` ; sinon `'stable'`.
- `get-today-actions/index.ts` (nouvelle Edge Function, `GET`, JWT vérifié dans le code) : fetch accounts (comptes churnés exclus, D1) + playbooks actifs + insights actifs de l'org, calcule via le helper ci-dessus, retourne `{ status, total, by_priority, by_category, mrr_at_risk_cents, actions }`. C'est le contrat que consommera la Phase Today du frontend (C2.4b) à la place du calcul client-side actuel.

**Décision de périmètre — `get-today-status`/`dashboard-api` non modifiés.** Leur logique de comptage `critical_count`/`p0_insights_count` (corrigée en C2.2 pour exclure les comptes churnés) reste correcte et testée en l'état — le bug réel n'était pas dans leur calcul mais dans l'absence totale de lien entre le statut portefeuille et le total "priority actions" affiché côté client. Faire consommer ce nouveau helper à ces deux fonctions n'aurait rien corrigé de plus et risquait de régresser du code déjà validé ; réévaluer seulement si un besoin concret apparaît.

**Tests** : `supabase/tests/today-actions-helpers.test.ts` (nouveau, 24 tests) — dont un test de non-régression explicite sur la contradiction trouvée par l'audit (`determinePortfolioStatus(206, 0)` ne peut jamais retourner `'stable'`).

---

## Churn Risk — exclusion des comptes churnés des KPIs/listes "at risk" (2026-08-02, C2.2)

Suite de C2.1 (état figé `churn_risk_band='churned'`) : audit de tous les points du backend calculant un KPI ou une liste "at risk"/"critical"/"danger", pour confirmer qu'aucun ne pouvait encore afficher un compte churné comme s'il était à risque.

**Confirmés déjà corrects (aucun changement)** — `get_portfolio_snapshot` (`at_risk_count`/`scored_accounts_count` filtrent déjà via la sémantique NULL de SQL), `churn-alert`/`onboarding-status`/`weekly-digest`/`get-top-churn-risks` (filtrent déjà `churn_risk_band='high'` ou `.not('churn_risk_score','is',null)`), `get-accounts-summary` (filtre déjà `mrr_cents > 0` en amont, commentaire explicite déjà présent), `outbound-webhook-dispatch`/`playbook-executor`/`playbook-execute`/`playbook-scheduler` (comparaisons numériques `churn_risk_score >= seuil` — `null` coerce à `0` en JS, un compte churné ne matche donc plus aucun seuil de déclenchement).

**Corrigés :**
- `get-today-status/index.ts` : `critical_count` comptait tout insight actif `priority='critical'`, y compris ceux restés actifs sur un compte devenu churné entre deux runs de `generate-insights`. Requête restructurée pour exclure les insights dont le compte a `churn_risk_band='churned'` (nouvelle fonction pure `countCriticalExcludingChurned`, testée).
- `dashboard-api/index.ts` (`handleBriefing`) : même correctif sur `p0_insights_count` (source du "N pending P0 actions" du `DailyBriefing`) — même fonction dupliquée localement (pas d'abstraction partagée pour 3 lignes).
- `generate-insights/index.ts` : root-cause — un compte à `mrr_cents=0` ne génère plus aucun insight (`payment_risk`/`renewal_alert`/`expansion_opportunity`/`usage_drop` pouvaient encore se déclencher sur des données historiques d'un compte déjà parti). `candidates=[]` déclenche l'auto-résolution déjà existante de `syncInsights` pour tout insight resté actif — corrige le problème à la source plutôt que de le filtrer en aval à chaque consommateur.
- Migration `20260802000002_accounts_priority_exclude_churned.sql` : la vue `accounts_with_priority` (alimente la colonne priorité de la page Accounts) pouvait classer un compte churné en `critical`/`watch` via sa branche de repli `health_score <= 30/55` — `health_score` n'est pas gelé par D1, un compte qui vient de churner avec des factures impayées historiques peut avoir un `payment_health_score` bas. Nouvelle branche `churn_risk_band='churned' → 'churned'` évaluée en premier.
- `onboarding-first-win/index.ts` : `at_risk_accounts` (top 3 du "aha moment" vu par un nouvel utilisateur), `mrr_at_risk` et `global_health_score` étaient calculés sur `health_score` seul, sans exclusion des comptes churnés — même gap que ci-dessus. Filtre `churn_risk_band != 'churned' OR IS NULL` ajouté (le `OR IS NULL` évite d'exclure par accident un compte pas encore scoré — `.neq()` seul aurait aussi droppé les NULL, sémantique SQL).

**Trouvé mais hors scope de ce chantier** : `AccountPriorityLabel` côté frontend (`src/lib/types/accounts.ts`) attend encore les valeurs françaises historiques (`'critique'/'surveillance'/'nouveau'`) alors que `accounts_with_priority` produit des valeurs anglaises (`'critical'/'watch'/'new'`) depuis la migration `20260725000002` — contrat déjà cassé indépendamment de ce chantier (`PRIORITY_STYLES`/`fr.accountPriority` ne matchent aucune valeur sauf `'stable'`, badge de priorité probablement vide en prod pour tout compte critique/watch/new). Nécessite son propre ticket — au minimum ajouter `'churned'` à ce contrat en même temps que la correction FR→EN.

**Tests** : `supabase/tests/get-today-status.test.ts` — 5 nouveaux tests sur `countCriticalExcludingChurned`.

---

## AI Insights — Contrat de pagination corrigé (2026-08-02, P0.2)

Audit préalable (audit rétention 2026-08) : `insights-crud handleList` retournait `{ insights, total_count, critical_count }` avec des query params `limit`/`offset` (contrat du 2026-07-05 ci-dessous), mais le frontend envoyait `page`/`per_page`/`sort` et lisait `listData?.data`/`listData?.pagination` — contrat cassé des deux côtés, probable cause d'une partie des symptômes de fatigue d'alerte observés (liste d'insights potentiellement vide/mal rendue en prod).

**Changements :**
- `insights-crud/index.ts` : `parseLimit`/`parseOffset` remplacés par `parsePage`/`parsePerPage` (1-indexé, `per_page` défaut 20 / max 100). `handleList` retourne désormais `{ data, pagination: { page, per_page, total_count }, critical_count }`. Le paramètre `sort` est accepté (le frontend l'envoie systématiquement) mais sans effet — le tri reste fixe côté SQL, requis par le `DISTINCT ON` de déduplication.
- `docs/PROMPT_FRONTEND_INSIGHTS_V1.md` mis à jour avec le contrat actuel et un historique des 3 formes successives de cet endpoint.

**Tests** : `supabase/tests/insights-crud.test.ts` — `parsePage`/`parsePerPage` remplacent `parseLimit`/`parseOffset` (mêmes bornes, nouveau défaut `page=1`).

---

## Accounts — priority_label calculé (2026-07-05)

Audit préalable : aucune vue SQL n'existait sur `accounts` (aucun fichier sous `supabase/views/`), et `accounts-api` (seul endpoint de liste de comptes — il n'y a pas de fonction `get-accounts`) sélectionnait directement la table `accounts` sans label de priorité calculé.

**Changements :**
- Migration `20260705000002_accounts_priority_label_view.sql` : vue `accounts_with_priority` (`WITH (security_invoker = true)` pour que la RLS de `accounts` s'applique à tout appelant, y compris hors service_role) — ajoute `priority_label` via `CASE` SQL, non stocké.
- `accounts-api/index.ts` : `handleList` sélectionne désormais depuis `accounts_with_priority` au lieu de `accounts`, ajoute `priority_label` à la liste de colonnes retournées. `handleGetOne` et `handlePatch` inchangés (écriture sur `accounts` directement).

**Règles `priority_label`** (priorité décroissante, exclusif) :
1. `critique` — `churn_risk_score >= 80` OU `health_score <= 30`
2. `surveillance` — `churn_risk_score >= 50` OU `health_score <= 55`
3. `nouveau` — `created_at` < 90 jours ET `churn_risk_score < 50`
4. `stable` — défaut

**Tests** : pas de nouveau test Vitest — la logique vit entièrement en SQL (`CASE` dans la vue), même convention que `list_deduplicated_insights` (voir entrée du 2026-07-05 ci-dessous).

---

## AI Insights — Pagination & Dedup v1 (2026-07-05)

Audit préalable sur `insights-crud` (aucune fonction `get-insights` n'existe — c'est `insights-crud` qui expose la liste). L'endpoint utilisait déjà une pagination (`page`/`per_page`), mais celle-ci divergeait du contrat documenté dans `API_CONTRACTS.md` (`limit`/`offset`). Le tri par défaut était `created_at DESC` (pas de priorisation), et aucune déduplication n'était appliquée : un compte pouvait accumuler plusieurs insights actifs-puis-résolus du même `insight_type` sur des jours différents, qui s'affichaient comme des doublons visuels une fois tous les statuts inclus dans le filtre.

**Contexte DB important** : la migration `20260704000001_fix_duplicate_accounts_and_insights.sql` a déjà posé un index unique `idx_ai_insights_org_account_type_day` interdisant plus d'une ligne par `(organization_id, account_id, insight_type, jour UTC)`, tous statuts confondus — donc les doublons stricts ne peuvent plus être insérés depuis cette date. Le `DISTINCT ON` ajouté ici est un filet de sécurité pour les lignes antérieures à cette contrainte, pas le mécanisme principal.

**Changements :**
- Migration `20260705000001_insights_dedup_rpc.sql` : fonctions SQL `list_deduplicated_insights` / `count_deduplicated_insights` — `DISTINCT ON (account_id, insight_type, created_at::date UTC)` puis tri `priority DESC → mrr_impact_cents DESC → created_at DESC`. Pas de colonne `detected_at` dans ce schéma (comme déjà noté dans la migration du 2026-07-04) — `created_at` utilisé à la place.
- `insights-crud/index.ts` : `handleList` remplace `page`/`per_page` par `limit`/`offset` (défaut 20, max 100) et appelle les deux RPC au lieu d'une query builder directe. Le tri n'est plus paramétrable par `?sort=` (nécessaire pour rendre le `DISTINCT ON` cohérent avec l'`ORDER BY` côté SQL) — aucun frontend ne consommait cet endpoint (vérifié : zéro référence à `insights-crud` sous `/src`), donc pas de rupture réelle.
- Réponse : `{ insights, total_count, critical_count }` remplace `{ data, pagination }`. `critical_count` = insights `active`+`critical` de l'org, indépendant des filtres de la requête — c'est ce champ (pas `total_count`) qui doit alimenter le badge de nav.
- `API_CONTRACTS.md` et `docs/PROMPT_FRONTEND_INSIGHTS_V1.md` mis à jour pour refléter le nouveau contrat (ces docs décrivaient un frontend pas encore construit).

**Tests** : `supabase/tests/insights-crud.test.ts` — 16 tests sur `parseLimit`, `parseOffset`, `parseCsvFilter` (parsing/validation purs ; la déduplication et le tri vivent en SQL et ne sont pas testables via Vitest).

---

## Today Portfolio Status v1 (2026-07-04)

Nouvelle Edge Function `get-today-status` : statut global du portefeuille pour la future page "Aujourd'hui". Fonctionnalité entièrement nouvelle — un audit préalable a confirmé qu'aucune page "Today" ni logique de statut global n'existait sur `main` (le seul champ proche, `health_trend` dans `dashboard-api`, est un delta de tendance KPI, pas un statut qualitatif). Une branche non mergée (`feat/export-playbook-accounts`) contient des helpers `today-actions-helpers.ts` avec une granularité par compte (P0/P1/P2), différente de ce statut agrégé.

### Règles de statut

1. `critical` si au moins 1 `ai_insights` actif avec `priority='critical'`
2. sinon `at_risk` si la part de comptes scorés (`churn_risk_score` non null) avec `churn_risk_score > 70` dépasse 30 %
3. sinon `stable`

### Réponse API

```json
{
  "data": {
    "status": "critical",
    "critical_count": 2,
    "total_mrr_cents": 1284500,
    "champions_count": 12,
    "top_urgent_account": {
      "id": "uuid",
      "name": "Acme Corp",
      "mrr": 49900,
      "risk_score": 82,
      "top_insight": "Facture impayée depuis 20 jours"
    }
  }
}
```

`top_urgent_account` = compte avec `churn_risk_score > 70` au MRR le plus élevé (`null` si aucun). `top_insight` = titre du plus prioritaire des insights actifs liés à ce compte (`''` si aucun — jamais `null`, pour que le frontend puisse appeler des méthodes string sans vérification).

`total_mrr_cents` = somme de `mrr_cents` sur tous les comptes de l'org (`accounts` n'a pas de colonne `status` — un compte churné a déjà `mrr_cents = 0`, donc la somme brute équivaut à un filtre "actif"). `champions_count` = memberships actifs du segment système `account_segments.segment_type = 'champions'` (valeur exacte de la CHECK constraint ; `accounts` n'a pas de colonne `segment` directe, l'appartenance passe par `segment_memberships`).

### Corrections post-revue (avant merge)

Un premier passage de revue avait proposé `total_mrr_cents` via `accounts.status = 'active'` et `champions_count` via `accounts.segment = 'champion'` — ni la colonne `status` ni la colonne `segment` n'existent sur `accounts` (vérifié dans les migrations). Corrigé pour utiliser le schéma réel : somme JS de `mrr_cents` (convention déjà suivie par `onboarding-first-win`/`weekly-digest`) et jointure `account_segments` → `segment_memberships` (convention suivie par `dashboard-api`/`account-summary`), avec le slug pluriel `champions` qui correspond à la CHECK constraint.

### Fichiers

| Fichier | Rôle |
|---------|------|
| `supabase/functions/get-today-status/index.ts` | Edge Function GET, `verify_jwt=false` (JWT vérifié dans le code) |
| `supabase/tests/get-today-status.test.ts` | 16 tests : `determineTodayStatus`, `selectTopUrgentAccount`, `selectTopInsightTitle`, `calcTotalMrrCents` |

---

## HubSpot Playbook Dispatch Audit (2026-05-28)

Audit complet de la fonctionnalité de dispatch playbook vers HubSpot. 8 corrections réparties en P0 (bugs bloquants), P1 (performance) et P2 (robustesse).

### Mapping de la séquence HubSpot

```
POST /playbook-execute (ou cron playbook-scheduler)
  └─ dispatchAction() [action-dispatcher.ts]
       └─ getBatchCompanyContacts(ids[]) → POST /crm/v3/associations/company/contact/batch/read
       └─ enrollInSequence(contactId, sequenceId, senderId)
            POST /automation/v4/sequences/{sequenceId}/enrollments
```

Les contacts enrollés apparaissent dans **HubSpot Sales > Sequences** et sur l'onglet Sequences de chaque fiche Contact. Sentio déclenche uniquement l'enrollment — le contenu et le timing des emails sont définis dans la séquence HubSpot.

### P0 — Bugs critiques corrigés

| Bug | Fichier | Correction |
|-----|---------|------------|
| `isTransient` ne détectait que les timeouts, pas les 429 | `hubspot-client.ts` | Détecte maintenant 429/502/503 |
| `enrollInSequence` + `updateCompanyProperties` retournaient `{ success: false }` sur 429 sans retry | `hubspot-client.ts` | Throw sur 429 à l'intérieur du callback `retryWithBackoff` |
| `send_email` dans playbook standard retournait `completed` sans rien envoyer | `action-dispatcher.ts` | Retourne `failed` avec message explicite |

### P1 — Performance

| Amélioration | Avant | Après |
|---|---|---|
| Récupération contacts HubSpot | 1 appel GET par compte (N+1) | `getBatchCompanyContacts` : POST batch, 100 companies/req, 2 appels max pour 200 comptes |
| Retry rate-limitées | `waitForToken()` avant `retryWithBackoff` seulement (retries non throttlés) | `waitForToken()` à l'intérieur du callback — chaque tentative est rate-limitée |
| `has_more` pour segments | Toujours `false` si `segment_id` | Correct : `accountIds.length >= MAX_ACCOUNTS_PER_RUN` |

### P2 — Robustesse

| Amélioration | Détail |
|---|---|
| Rate limiter | Réduit de 5 à 3/sec — HubSpot standard = 10/sec, marge de 40 % pour instances Deno concurrentes |
| KPI TOCTOU | Remplacé read-then-write par `supabase.rpc('increment_playbook_kpis')` — `UPDATE SET col = col + N` atomique |
| Exécution séquentielle | Boucle `for (account)` → `processAccount` closure + `Promise.allSettled` par chunks de 5 dans `playbook-execute` et `playbook-scheduler` |

### Fichiers modifiés

| Fichier | Changements |
|---------|-------------|
| `_shared/hubspot-client.ts` | `isTransient` étendu, `waitForToken` dans callbacks, throw 429, `getBatchCompanyContacts` |
| `_shared/action-dispatcher.ts` | `contactsCache?: Map<string, string[]>` dans `DispatchContext`, case `send_email` explicite |
| `playbook-execute/index.ts` | Pre-fetch batch, `processAccount` + chunks parallèles, KPI via RPC, `has_more` corrigé |
| `playbook-scheduler/index.ts` | Pre-fetch batch, `processAccount` + chunks parallèles, KPI via RPC |
| `migrations/20260528000001_increment_playbook_kpis.sql` | Fonction `increment_playbook_kpis(p_playbook_id, eligible, targeted, reached)` |

---

## Onboarding Flow Backend v1 (2026-04-30)

Flux d'onboarding complet côté backend : de l'inscription jusqu'au "aha moment" (voir ses premiers comptes à risque). Enrichissement de `onboarding-status` existant + nouvelle Edge Function `onboarding-first-win`.

### Décision d'architecture — pas de table `onboarding_state`

L'état d'onboarding est dérivé des sources de vérité existantes plutôt que dupliqué dans une table séparée :

| Donnée | Source |
|--------|--------|
| `stripe_connected` | `data_syncs` (sync_source='stripe', sync_status='completed') |
| `hubspot_connected` | `data_syncs` (sync_source='hubspot', sync_status='completed') |
| `first_win_seen` | `organizations.aha_moment_seen_at` |
| `onboarding_completed` | `organizations.onboarding_completed` |

Créer une table séparée aurait introduit deux sources de vérité divergentes et des problèmes de cohérence.

### Modifications Edge Functions

#### `onboarding-status` — GET enrichi

Nouveaux champs dans la réponse :

| Champ | Type | Description |
|-------|------|-------------|
| `current_step` | `'stripe' \| 'hubspot' \| 'first_win' \| 'done'` | Étape courante de l'onboarding |
| `at_risk_count` | `number` | Comptes avec `health_score < 40` |
| `onboarding_completed` | `boolean` | Onboarding définitivement terminé |

Logique `current_step` (if/else chain) :
1. `!stripe_connected` → `'stripe'`
2. `stripe && !hubspot && !onboarding_completed` → `'hubspot'` (skippable via PATCH)
3. `stripe && !first_win_seen` → `'first_win'`
4. → `'done'`

#### `onboarding-status` — PATCH endpoint (nouveau)

```
PATCH /onboarding-status
Body: { field: 'first_win_seen' | 'onboarding_completed', value: true }
Response 200: { success: true }
```

- `first_win_seen = true` → écrit `organizations.aha_moment_seen_at` (idempotent)
- `onboarding_completed = true` → écrit `organizations.onboarding_completed = true`
- Le `POST /aha-seen` existant est conservé pour rétrocompatibilité

### Nouvelle Edge Function `onboarding-first-win`

```
GET /onboarding-first-win
Auth: Bearer token (JWT ES256)
```

Retourne les données du aha moment :

```json
{
  "data": {
    "total_accounts": 42,
    "at_risk_accounts": [
      {
        "stripe_customer_id": "cus_xxx",
        "display_name": "Acme Corp",
        "health_score": 18,
        "churn_risk": 82,
        "mrr": 49900,
        "top_risk_reason": "Invoice impayée depuis 20 jours"
      }
    ],
    "mrr_at_risk": 148700,
    "global_health_score": 63
  }
}
```

**Logique `top_risk_reason` (zero N+1 — 2 queries batch pour les top 3) :**
1. Invoice `open/uncollectible` avec `due_date < today-7j` → `"Invoice impayée depuis X jours"`
2. Dernier `usage_event` > 30 jours ou absent → `"Aucune connexion depuis X jours"`
3. `financial_score < 30` → `"Santé financière dégradée"`
4. Fallback → `"Score de santé faible"`

### Nouveaux fichiers

| Fichier | Rôle |
|---------|------|
| `supabase/functions/onboarding-first-win/index.ts` | Edge Function GET aha moment |
| `supabase/tests/onboarding-first-win.test.ts` | 25 tests : sélection top 3, mrr_at_risk, global_health_score, buildRiskReason, Zero-PII |
| `supabase/tests/onboarding-status.test.ts` | 17 tests : determineCurrentStep (9 cas), validatePatchBody (8 cas) |

### Tests

42 nouveaux tests, 322 total (anciens 280 + 42) :

- `determineCurrentStep` : 9 cas couvrant les 4 étapes + transitions skip HubSpot
- `validatePatchBody` : 8 cas (champs valides, value!=true, string "true", field inconnu, body null)
- `buildRiskReason` : 7 cas (facture, singulier/pluriel, usage absent, usage>30j, financial, fallback, priorité)
- Sélection top 3 : 4 cas (tri ASC, < 3 comptes, null health_score, aucun compte scoré)
- `calcMrrAtRisk` : 4 cas (seuil strict < 40, aucun risque, mrr null, health null)
- `calcGlobalHealthScore` : 4 cas (moyenne, arrondi, liste vide, null)
- Zero-PII : 5 cas (email, phone, ip, name absents ; stripe_customer_id présent)

### Registration config.toml

```toml
[functions.onboarding-first-win]
verify_jwt = false
```

---

## HubSpot Playbook Dispatch v1 (2026-04-26)

Dispatch réel des actions playbook vers HubSpot. Remplace le stub log-only (`executeAction`) par un dispatcher async (`dispatchAction`) branché sur l'API HubSpot, avec rate limiting, retry et DLQ.

### Architecture Zero-PII

Les appels HubSpot n'utilisent que des identifiants opaques (`hubspot_company_id`, `contactId` HubSpot). Sentio ne stocke ni ne transmet jamais d'email, nom ou téléphone. L'outil d'emailing du client (HubSpot) détient les emails et les utilise lors de l'enrôlement.

### Nouveaux fichiers

| Fichier | Rôle |
|---------|------|
| `_shared/hubspot-client.ts` | Client API HubSpot : `getCompanyContacts()`, `enrollInSequence()`, `updateCompanyProperties()` — rate limiter 5 appels/sec, timeout 10s, retry 2x |
| `_shared/action-dispatcher.ts` | `dispatchAction()` async — dispatch HubSpot réel + fallback log-only pour les autres types + DLQ sur échec |

### Nouveaux types d'actions playbook

| Type | Config requise | Comportement |
|------|---------------|--------------|
| `hubspot_enroll_sequence` | `sequence_id`, `sender_id` | Récupère les contacts de la company HubSpot, enrôle jusqu'à 5 contacts dans la séquence |
| `hubspot_update_company` | `properties: {...}` | PATCH des propriétés HubSpot de la company (ex: `hs_lead_status: "at_risk"`) |

**Logique d'enrôlement :**
1. Récupère les contacts associés à `account.hubspot_company_id` via `GET /crm/v3/objects/companies/{id}/associations/contacts`
2. Enrôle en parallèle (`Promise.allSettled`) jusqu'à 5 contacts via `POST /automation/v4/sequences/{seqId}/enrollments`
3. Si 0 contact → status `skipped` (pas d'erreur)
4. Si échec partiel ou total → `writeToDLQ` provider `hubspot` + status selon résultat

### Modifications shared

- `playbook-engine.ts` : `VALID_ACTION_TYPES` étendu avec `hubspot_enroll_sequence` et `hubspot_update_company` ; `AccountData` enrichi avec `stripe_customer_id` et `hubspot_company_id`

### Modifications Edge Functions

- `playbook-execute` + `playbook-scheduler` : SELECT accounts étendu (`stripe_customer_id`, `hubspot_company_id`) ; `executeAction()` → `dispatchAction()` async
- Les actions non-HubSpot continuent en log-only (V1, pas de régression)

### Tests

`supabase/tests/action-dispatcher.test.ts` — 15 tests :
- Enrollment succès (2 contacts), config manquante, hubspot_company_id absent, 0 contact en HubSpot
- DLQ écrit sur échec total (429) et sur échec partiel (1/3 contacts)
- Limite à 5 contacts max
- Actions log-only (slack_notify, create_task) : pas d'appel externe
- Zero-PII : payload DLQ ne contient pas `@`, `email`, `phone`, `ip`

### Prérequis côté client

- Variable d'env `HUBSPOT_API_KEY` (Private App token HubSpot) configurée dans les secrets Supabase
- Les contacts du client doivent déjà exister dans HubSpot et être associés à leurs companies
- Le `sender_id` = HubSpot User ID de l'expéditeur (visible dans HubSpot → Paramètres → Utilisateurs & Équipes)

---

## Outbound Webhook System v1 (2026-04-26)

Système de webhooks sortants universel : Sentio pousse automatiquement un payload JSON vers des URLs externes (Brevo, Lemlist, Slack, etc.) quand un compte change de segment ou franchit un seuil de churn.

### Architecture Zero-PII

Le payload envoyé ne contient **jamais** d'email, nom, téléphone ni IP. Uniquement `stripe_customer_id` + métriques agrégées. C'est l'outil d'emailing du client qui détient les emails et déclenche les séquences.

### Nouvelles tables

| Table | Rôle |
|-------|------|
| `outbound_webhook_destinations` | Destinations configurées par org : URL, provider, trigger_segments, trigger_churn_threshold, secret header |
| `outbound_webhook_logs` | Audit de chaque tentative de dispatch (success, HTTP status, response_body tronquée 500 chars) |

Migration : `20260426000001_outbound_webhooks.sql`  
— RLS org_isolation sur les deux tables  
— CHECK `provider IN ('brevo','mailchimp','lemlist','activecampaign','slack','custom')`  
— CHECK `triggered_by IN ('segment_change','churn_threshold','manual')`  
— Extension du CHECK `webhook_dead_letter.provider` : ajout de `'outbound'`

### Nouvelles Edge Functions

| Fonction | Trigger | Rôle |
|----------|---------|------|
| `outbound-webhook-dispatch` | POST (service_role) | Dispatch vers toutes les destinations matchées d'une org |
| `outbound-webhook-test` | POST (JWT ES256) | Test unitaire d'une destination depuis l'UI |

**Logique de dispatch (`outbound-webhook-dispatch`) :**
1. Récupère les destinations actives de l'org
2. Filtre : `segment_current ∈ trigger_segments` OU `churn_risk_score >= trigger_churn_threshold`
3. Envoie en parallèle (`Promise.allSettled`) avec timeout 10s
4. Ajoute le secret header si configuré (`secret_header_name: secret_header_value`)
5. Log dans `outbound_webhook_logs` (succès et échecs)
6. En cas d'échec, écrit dans `webhook_dead_letter` (`provider: 'outbound'`) pour retry

**Payload envoyé (Zero-PII) :**
```json
{
  "source": "sentio_ai",
  "event": "account_risk_detected",
  "account": {
    "stripe_customer_id": "cus_XXX",
    "segment": "en_danger_critique",
    "segment_previous": "a_risque_leger",
    "health_score": 28,
    "churn_risk_score": 75,
    "expansion_score": 12,
    "mrr_cents": 49900,
    "mrr_eur": 499
  },
  "triggered_at": "2026-04-26T13:53:00Z",
  "organization_id": "uuid"
}
```

### Intégration calculate-scores

Après la mise à jour des scores de chaque compte, détection automatique :
- **Changement de segment primaire** : comparaison old/new via `determineSegmentTypes()`
- **Seuil churn** : `churn_risk_score >= 60`

Si l'une des conditions est vraie, le compte est ajouté à une file de dispatch. La file est envoyée en **fire-and-forget** (`Promise.allSettled` non-await) après tous les batchs de l'org — le scoring n'est jamais bloqué.

Champs ajoutés au SELECT accounts : `stripe_customer_id`, `expansion_score`.

### Modifications shared

- `_shared/dlq.ts` : type `provider` étendu avec `'outbound'`

### Tests

`supabase/tests/outbound-webhook-dispatch.test.ts` — 21 tests :
- Filtrage correct par segment (match, no-match, union segment∨churn)
- Filtrage correct par churn_threshold (gte, lt, égalité exacte)
- Destinations inactives ignorées
- Payload Zero-PII vérifié (absence de `email`, `name`, `phone`, `ip`)
- Log `outbound_webhook_logs` avec `success=true` pour 2xx, `success=false` pour 4xx

---

## Stability Plan v1 (2026-03-02)

Infrastructure de résilience et observabilité ajoutée aux Edge Functions.

### Shared Utilities (`supabase/functions/_shared/`)

| Module | Rôle |
|--------|------|
| `fetch-with-timeout.ts` | Timeout 8s sur appels HTTP externes (AbortController) |
| `retry-with-backoff.ts` | Retry exponentiel avec jitter (3 tentatives max) |
| `circuit-breaker.ts` | Circuit breaker in-memory (open après 5 échecs, reset 60s) |
| `cron-lock.ts` | Verrou distribué via table `cron_locks` avec TTL |
| `dlq.ts` | Écriture dans `webhook_dead_letter` pour événements échoués |
| `slack-alert.ts` | Alertes Slack fire-and-forget (5s timeout) |
| `structured-logger.ts` | Logs JSON avec `correlation_id`, `function_name`, `provider` |
| `metrics.ts` | Écriture dans `sync_metrics` |
| `scoring.ts` | Fonctions de scoring pures + segmentation (`determineSegmentTypes`) |

### Patterns de résilience appliqués

- **sync-stripe** : `stripeGet()` → retry + circuit breaker + fetchWithTimeout + pagination max 50 pages + cron lock
- **calculate-scores** : cron lock + DataSyncLogger par org + Slack alerting + segment assignment post-scoring
- **stripe-webhook** : DLQ write + Slack alert sur échec handler
- **Tous** : try/catch sur `createServiceClient()`, CORS headers sur réponses

### Bug fixes appliqués

- `calculate-scores` : mutation builder `orgQuery` (filtre org_id silencieusement ignoré)
- `sync-stripe` + `stripe-webhook` : détection intervalle annuel (`price.recurring.interval`)
- `sync-stripe` : agrégation MRR multi-abonnement par compte
- `supabase-client.ts` : headers CORS sur `jsonResponse`/`errorResponse`
- `track-usage` : suppression overhead DataSyncLogger par événement

---

## Scoring & Segmentation v1 (2026-03-03)

Bug fixes critiques sur le pipeline de données + ajout de la segmentation automatique.

**Causes racines corrigées :**
- `sync-stripe` : full-sync systématique des subscriptions (le filtre `created[gt]` ratait les mises à jour/annulations)
- `sync-stripe` : propagation `billing_interval`, `seat_count`, `contract_start_date`, `contract_end_date` vers `accounts`
- `stripe-webhook` : agrégation MRR depuis TOUTES les subscriptions actives (au lieu d'écraser avec une seule)
- `calculate-scores` : error checking sur les upserts `score_history` et `accounts.update`
- `calculate-scores` : utilisation des fonctions exportées `calcHealthScore`/`calcChurnRiskScore` (plus de duplication inline)
- Fix type `StripeSubscription` : ajout `price.recurring.interval` (suppression des casts unsafe)
- Contrainte CHECK `subscriptions.status` élargie : `incomplete_expired`, `unpaid`

**Segmentation automatique :**
- 8 segments SaaS B2B : Champions, En expansion, Stables, À risque léger, En danger critique, Impayés, En churn, Nouveaux (< 90j)
- `scoring.ts` : `determineSegmentTypes()` — score-based exclusif + `nouveaux` non-exclusif
- `calculate-scores` : `ensureSystemSegments()` + `assignSegments()` après chaque run de scoring

**Règles de segmentation (priorité décroissante, mutuellement exclusif sauf `nouveaux`) :**
1. `nouveaux` — créé < 90 jours (non-exclusif, se cumule avec un segment score-based)
2. `en_churn` — MRR = 0
3. `impayes` — factures impayées
4. `en_danger_critique` — churn_risk >= 70
5. `a_risque_leger` — churn_risk >= 50
6. `champions` — health >= 80
7. `en_expansion` — expansion >= 70 ET health >= 60
8. `stables` — défaut

---

## Playbooks Backend v1 (2026-03-03)

Implémentation complète du backend playbooks : moteur, CRUD, exécution, scheduler.

**Edge Functions :**

| Fonction | Trigger | Rôle |
|----------|---------|------|
| `playbook-crud` | REST (JWT) | CRUD playbooks avec validation, pagination, soft delete |
| `playbook-execute` | POST (JWT) | Exécute un playbook sur des comptes spécifiques ou un segment |
| `playbook-scheduler` | POST (cron) | Exécution automatique des playbooks planifiés |

**Format JSONB `actions` :**
```json
[
  { "type": "slack_notify", "config": { "channel": "#cs-team" }, "order": 1 },
  { "type": "create_task", "config": { "title": "Follow-up" }, "order": 2 }
]
```
Types d'actions : `slack_notify`, `create_task`, `assign_owner`, `update_tag`, `log_note`, `schedule_review`, `flag_for_review`

**Format JSONB `trigger_conditions` / `eligibility_criteria` :**
```json
{
  "operator": "AND",
  "conditions": [
    { "field": "churn_risk_score", "operator": "gte", "value": 70 },
    { "field": "plan_tier", "operator": "in", "value": ["growth", "enterprise"] }
  ]
}
```
Opérateurs : `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`. Logique : `AND` / `OR`.

**Auth ES256 :** `_shared/auth.ts` vérifie le JWT via `supabase.auth.getUser()` (compatible ES256). `playbook-crud` et `playbook-execute` : `verify_jwt = false` + auth dans le code. `playbook-scheduler` : `verify_jwt = true` (cron = service_role HS256).

---

## Stability Audit v2 (2026-03-04)

71 issues identifiées, 6 phases implémentées.

**Phase 1 — Sécurité :** 3 failles cross-tenant critiques corrigées (auth.ts null org_id, playbook-crud scoping, track-usage filter). Open redirect fix. CSP header.

**Phase 2 — Fiabilité Edge Functions :** Batching 500 comptes, `scoreAccountPure()` pure, Maps pré-construites, segments atomiques, `.limit(500)`.

**Phase 3 — Frontend :** Session refresh middleware, error boundaries, skeleton UI, env validation, health endpoint, `.limit(10000)`.

**Phase 4 — Database :** CHECK constraints, unique constraints, ON DELETE CASCADE, index stuck executions.

**Phase 5 — CI/CD :** npm audit step, deploy gaté, config.toml registration.

**Phase 6 — Monitoring :** Auto-fail playbook_executions bloquées > 15 min.

---

## Stability Audit v3 (2026-03-04)

16 fichiers modifiés.

**Data Integrity :** Fix TOCTOU stripe-webhook, idempotency check event.id, `.maybeSingle()`.

**Sécurité :** CSP sans unsafe-eval, Permissions-Policy, error digest (pas message brut), open redirect decode fix, auth getUser try/catch.

**Frontend :** Login `?next=` redirect, Suspense boundaries, singleton Supabase client, env fallbacks.

**Infrastructure :** self-monitor cron lock, MAX_BATCHES guard, `.limit()` sur queries, cross-tenant enforcement.

---

## Stability Audit v4 (2026-03-04)

10 fichiers modifiés.

**Data Integrity :** Tous `.single()` → `.maybeSingle()`, timestamp validation, `|| 1` pour maxMrrCents.

**Crash Prevention :** auth.ts try/catch séparés, releaseCronLock safety wrappers.

**Frontend :** RefreshDataButton AbortController, SyncStatus fallback UI, rate limit 60s.

**Housekeeping :** DLQ cleanup > 30j, workflow-executor console.warn.

---

## Scoring Audit V1 (2026-03-04)

- `calcUsageScore` : 50 (neutre) quand `total_events = 0`
- `calcEngagementScore` : NPS supprimé du V1, tickets (±25 pts) + meetings (±25 pts)
- Valeurs neutres : Usage=50, Financial=0, Engagement=50, Contrat=50

---

## Scoring Sub-Scores Persistence (2026-03-05)

Migration `20260305000002_add_subscores_columns.sql` : ajout `financial_score`, `engagement_score`, `contract_score` aux tables `accounts` et `score_history`.

---

## AI Insights Backend v1 (2026-03-05)

5 types d'insights : `churn_prediction`, `expansion_opportunity`, `renewal_alert`, `payment_risk`, `usage_drop`. Déduplication par index unique partiel. Auto-résolution.

---

## Auth Session Stability (2026-03-04)

`AuthListener.tsx` composant client → `onAuthStateChange` → `router.refresh()` sur TOKEN_REFRESHED/SIGNED_OUT.

---

## Migrations

| Migration | Contenu |
|-----------|---------|
| `20260302000001_stability_indexes.sql` | 10 index de performance |
| `20260303000001_scoring_segmentation_fixes.sql` | CHECK élargie, seed segments, index unique partiel |
| `20260304000001_stability_phase2_fixes.sql` | CHECK data_syncs, unique segment_memberships |
| `20260304000002_stability_phase3_4.sql` | CASCADE, CHECK playbooks/executions, index stuck |
| `20260305000002_add_subscores_columns.sql` | 3 sous-scores sur accounts + score_history |
| `20260305000003_insights_improvements.sql` | FK CASCADE, index déduplication, source_scores JSONB |

---

## UI Freeze Instrumentation (2026-03-05)

Ajout d'instrumentation temporaire (`// TEMP DEBUG`) pour rendre les freezes UI intermittents visibles et traçables. Préfixe uniforme `[SENTIO_DEBUG]` pour filtrage console/logs Vercel.

**Nouveau composant :**
- `src/components/GlobalErrorCatcher.tsx` — `'use client'`, monté dans root layout. Capture :
  - `window.unhandledrejection` → promesses rejetées silencieuses
  - `window.error` → erreurs non captées par React
  - `PerformanceObserver('longtask')` → tâches bloquantes > 50ms

**Error boundaries enrichis :**
- `global-error.tsx`, `error.tsx`, `dashboard/error.tsx` : log structuré avec `message`, `stack`, `digest`, `timestamp`, `url` (au lieu du digest seul)

**Logs aux points critiques :**

| Fichier | Point instrumenté | Signal |
|---------|-------------------|--------|
| `AuthListener.tsx` | mount/unmount + `onAuthStateChange` | Boucles de refresh token, déconnexions inattendues |
| `RefreshDataButton.tsx` | fetch start/end/error | Appels API lents ou échoués avec `duration_ms` |
| `middleware.ts` | `getUser()` | Auth lent (> 2s) ou erreur auth service |
| `dashboard/page.tsx` | Query `accounts` | Durée query côté serveur |

**Réversibilité :** `grep -r "TEMP DEBUG" src/` → supprimer les blocs correspondants + `GlobalErrorCatcher.tsx`.

---

## Backlog

- Créer `sync-hubspot` Edge Function
- Propager `contract_end_date` dans `stripe-webhook`
- NPS : collecte + intégration scoring (V2)
