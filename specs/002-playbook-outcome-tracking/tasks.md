---

description: "Task list for feature implementation"
---

# Tasks: Boucle de preuve de résultat des playbooks (backend)

**Input**: Design documents from `/specs/002-playbook-outcome-tracking/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Incluses — convention Vitest systématique du projet (`supabase/tests/`).

**Organization**: Tasks groupées par user story (US1 = marquage manuel, US2 = détection auto via Stripe, US3 = lien traçable + clics, US4 = lecture d'état/stats/nudge — ajoutée lors de l'alignement frontend du 2026-07-26).

## Format: `[ID] [P?] [Story] Description`

## Path Conventions

Monorepo existant — `supabase/functions/`, `supabase/migrations/`, `supabase/tests/` (cf. plan.md § Project Structure).

---

## ⚠️ Rappels de gouvernance à respecter dans toute l'implémentation de ce chantier

Ces deux points ont été explicitement signalés en Constitution Check du plan.md et doivent structurer les tâches ci-dessous :

1. **`stripe-webhook/index.ts`** : toute modification doit être un **ajout ciblé** (str_replace) au `switch` existant après le traitement de `invoice.paid`, **jamais** une réécriture de `handleInvoiceEvent`. Le hook ajouté doit être fire-and-forget (non-bloquant), sur le modèle exact déjà en place pour `invoice.payment_failed` → `playbook-executor`.
2. **`playbook-link/index.ts`** (`GET /playbook-link/{execution_id}`) : la destination de redirection DOIT être résolue **côté serveur uniquement**, à partir de l'exécution — jamais depuis un paramètre de requête arbitraire (anti-open-redirect).

Ces deux points nécessitent une **validation utilisateur explicite avant `/speckit-implement`**, conformément à la clause de gouvernance de la constitution — voir T012 et T018 ci-dessous.

---

## Phase 1: Setup

- [ ] T001 Vérifier la structure exacte actuelle de `playbook_executions` (`executed_at`, `account_converted`, `conversion_type`, `converted_at`) dans les migrations existantes, pour confirmer qu'aucune colonne de ce chantier n'entre en collision (cf. research.md)

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: Aucune story ne peut être implémentée avant la fin de cette phase.

- [ ] T002 Créer la migration `supabase/migrations/<timestamp>_playbook_outcome_tracking.sql` : `ALTER TABLE playbooks ADD COLUMN attribution_window_days integer CHECK (attribution_window_days > 0)` ; `ALTER TABLE playbook_executions ADD COLUMN attribution_deadline_at timestamptz, ADD COLUMN resolved_via text CHECK (resolved_via IN ('invoice_paid_auto','manual')), ADD COLUMN nudge_response text CHECK (nudge_response IN ('resolved','not_resolved','unsure')), ADD COLUMN nudge_responded_at timestamptz` ; `CREATE TABLE playbook_execution_clicks` (`id`, `organization_id`, `playbook_execution_id`, `stripe_customer_id`, `clicked_at`, `created_at`) + RLS org_isolation (cf. data-model.md)
- [ ] T003 Appliquer la migration T002 en local et vérifier la RLS de `playbook_execution_clicks` avec un utilisateur de test
- [ ] T004 [P] Implémenter les helpers purs dans `supabase/functions/_shared/playbook-engine.ts` (ajout ciblé) : `calculateAttributionDeadline(executedAt, attributionWindowDays)`, `deriveAttributionStatus(execution, now)` → `'not_executed'|'active'|'expired'|'resolved'` (cf. data-model.md)

**Checkpoint**: Schéma prêt, helpers de calcul disponibles — US1 à US4 peuvent démarrer.

---

## Phase 3: User Story 1 - Marquer un playbook comme exécuté (Priority: P1) 🎯 MVP

**Goal**: Un CSM marque une exécution comme exécutée, avec horodatage et fenêtre d'attribution associée.

**Independent Test**: Marquer une exécution, vérifier l'horodatage et `attribution_deadline_at` ; re-marquer, vérifier l'idempotence.

### Tests for User Story 1

- [ ] T005 [P] [US1] Test `mark-executed` sur exécution non marquée → `executed_at` renseigné, `attribution_deadline_at = executed_at + attribution_window_days` dans `supabase/tests/playbook-execute.test.ts`
- [ ] T006 [P] [US1] Test `mark-executed` sans `attribution_window_days` configuré sur le playbook → valeur par défaut 14 jours appliquée dans `supabase/tests/playbook-execute.test.ts`
- [ ] T007 [P] [US1] Test `mark-executed` idempotent : deuxième appel sur exécution déjà marquée → `200`, pas de nouvel horodatage dans `supabase/tests/playbook-execute.test.ts`
- [ ] T008 [P] [US1] Test `mark-executed` sur exécution inexistante/hors organisation → `404` dans `supabase/tests/playbook-execute.test.ts`
- [ ] T008A [P] [US1] Test `unmark-executed` (cf. `API_CONTRACTS.md` § 8.1.1, décision produit du 2026-07-27) : dans les 5 min → `executed_at`/`attribution_deadline_at` remis à `null` ; après 5 min → `409` ; sur exécution non marquée → `200` idempotent ; si `account_converted = true` → `409` ; si `nudge_response IS NOT NULL` → `409` (priment sur l'expiration des 5 min) dans `supabase/tests/playbook-execute.test.ts`

### Implementation for User Story 1

- [ ] T009 [US1] Implémenter la sous-route `POST /playbook-execute/{execution_id}/mark-executed` (routage par path dans `supabase/functions/playbook-execute/index.ts`, distincte du corps `POST /playbook-execute` — décision actée, cf. `API_CONTRACTS.md` § 8.1 et plan.md § Structure Decision) : Auth JWT ES256 → scoping `organization_id` → idempotence → écriture `executed_at`/`attribution_deadline_at` via T004 (dépend de T002, T004)
- [ ] T009A [US1] Implémenter la sous-route `POST /playbook-execute/{execution_id}/unmark-executed` (cf. `API_CONTRACTS.md` § 8.1.1, décision produit du 2026-07-27) : Auth JWT ES256 → scoping `organization_id` → vérifier conflits (`account_converted`/`resolved_via` non nul → `409`, `nudge_response` non nul → `409`) → vérifier fenêtre de 5 min depuis `executed_at` (dépassée → `409`) → idempotence si non marqué → écriture `executed_at = null`/`attribution_deadline_at = null` (dépend de T002, T009)

**Checkpoint**: US1 fonctionnelle et testable indépendamment.

---

## Phase 4: User Story 2 - Détection automatique de résolution via le sync Stripe existant (Priority: P1)

**Goal**: Une exécution marquée exécutée est automatiquement résolue quand `invoice.paid` est reçu pour le compte dans la fenêtre d'attribution, sans toucher au traitement Stripe existant.

**Independent Test**: Marquer une exécution, simuler `invoice.paid` dans la fenêtre → résolue ; après expiration → non résolue ; sans exécution en attente → comportement Stripe existant inchangé.

### Tests for User Story 2

- [ ] T010 [P] [US2] Test `playbook-outcome-detector` : exécution en attente + `invoice.paid` dans la fenêtre → `account_converted = true`, `resolved_via = 'invoice_paid_auto'`, `converted_at` renseigné dans `supabase/tests/playbook-outcome-detector.test.ts`
- [ ] T011 [P] [US2] Test `playbook-outcome-detector` : fenêtre expirée → pas de résolution automatique dans `supabase/tests/playbook-outcome-detector.test.ts`
- [ ] T012 [P] [US2] Test `playbook-outcome-detector` : plusieurs exécutions actives en attente pour le même compte → toutes marquées résolues (FR-010, cf. Assumptions) dans `supabase/tests/playbook-outcome-detector.test.ts`
- [ ] T013 [P] [US2] Test non-régression : `handleInvoiceEvent` existant produit un résultat identique à l'avant-chantier pour un compte sans exécution en attente (SC-003) dans `supabase/tests/stripe-webhook.test.ts` (fichier existant, ajout de cas)

### Implementation for User Story 2

- [ ] T014 [US2] Implémenter `supabase/functions/playbook-outcome-detector/index.ts` : Auth `service_role` uniquement → body `{ organization_id, stripe_customer_id }` → résout `account_id` → sélectionne les exécutions en attente (requête data-model.md) → marque résolues (dépend de T002, T004)
- [ ] T015 [US2] **[Point de gouvernance — validation utilisateur explicite requise avant implémentation]** Ajouter, par modification ciblée (str_replace) du `switch` existant dans `supabase/functions/stripe-webhook/index.ts`, un hook fire-and-forget vers `playbook-outcome-detector` immédiatement après le traitement existant du cas `'invoice.paid'` — sur le modèle exact du hook déjà en place pour `'invoice.payment_failed'` → `playbook-executor` (fetch non-bloquant, `.catch()` + `console.warn`, pas de retry). **Ne pas modifier `handleInvoiceEvent` lui-même.** (dépend de T014)
- [ ] T016 [US2] Enregistrer `playbook-outcome-detector` dans `supabase/config.toml` (appel interne service_role, non exposé publiquement, cohérent avec `playbook-executor`)

**Checkpoint**: US1+US2 forment la boucle de preuve minimale — marquage + résolution automatique, sans régression sur le webhook existant.

---

## Phase 5: User Story 3 - Lien traçable optionnel avec log de clic (Priority: P3)

**Goal**: Lien traçable par exécution, log de clic Zero-PII, redirection sécurisée.

**Independent Test**: Générer un lien, le visiter, vérifier le log de clic (Zero-PII) et la redirection ; revisiter → nouveau log distinct.

### Tests for User Story 3

- [ ] T017 [P] [US3] Test `playbook-link` : visite → `302` vers la destination prévue + ligne créée dans `playbook_execution_clicks` dans `supabase/tests/playbook-link.test.ts`
- [ ] T018 [P] [US3] Test Zero-PII : la ligne créée ne contient que `organization_id`, `playbook_execution_id`, `stripe_customer_id`, `clicked_at` (FR-008, SC-004) dans `supabase/tests/playbook-link.test.ts`
- [ ] T019 [P] [US3] Test anti-open-redirect : la destination de redirection est résolue uniquement depuis l'exécution en base, jamais depuis un paramètre de requête — vérifier qu'aucun paramètre externe n'influence la destination dans `supabase/tests/playbook-link.test.ts`
- [ ] T020 [P] [US3] Test absence de déduplication : deux visites du même lien → deux lignes distinctes dans `playbook_execution_clicks` dans `supabase/tests/playbook-link.test.ts`
- [ ] T021 [P] [US3] Test `playbook-link` sur `execution_id` inconnu → `404` sans fuite d'information sur l'organisation dans `supabase/tests/playbook-link.test.ts`

### Implementation for User Story 3

- [ ] T022 [US3] **[Point de gouvernance — validation utilisateur explicite requise sur la conception anti-open-redirect avant implémentation]** Implémenter `supabase/functions/playbook-link/index.ts` (`GET /playbook-link/{execution_id}`) : vérifier l'existence de l'exécution → insérer le log de clic → résoudre la destination de redirection **exclusivement côté serveur** à partir de l'exécution (jamais un paramètre de requête) → répondre `302` (dépend de T002)
- [ ] T023 [US3] Enregistrer `playbook-link` dans `supabase/config.toml` (`verify_jwt = false` — endpoint public sans session, cf. contracts/)

**Checkpoint**: US1+US2+US3 fonctionnent ensemble sans dépendance croisée bloquante.

---

## Phase 6: User Story 4 - Lecture d'état, taux de résolution et nudge de confirmation (Priority: P2)

*(ajoutée lors de l'alignement avec les dépendances frontend du 2026-07-26)*

**Goal**: Exposer l'état d'attribution d'une exécution, le taux de résolution exécuté vs non-exécuté avec taille d'échantillon, et permettre l'enregistrement d'une réponse à un nudge de confirmation.

**Independent Test**: Consulter l'état d'attribution à différents moments ; consulter le taux de résolution d'un playbook mixte ; soumettre une réponse de nudge.

### Tests for User Story 4

- [ ] T024 [P] [US4] Test `GET /playbook-execute/{id}/attribution-status` : retourne `attribution_status` correct pour chacun des 4 états (`not_executed`, `active`, `expired`, `resolved`) et `time_remaining_seconds` cohérent dans `supabase/tests/playbook-execute.test.ts`
- [ ] T025 [P] [US4] Test `GET /playbook-outcome-stats` : agrégation correcte exécuté/non-exécuté, `sample_size_warning = true` si `sample_size < 20`, `resolution_rate = null` si `sample_size = 0` (jamais `0`) dans `supabase/tests/playbook-outcome-stats.test.ts`
- [ ] T026 [P] [US4] Test `POST /playbook-execute/{id}/nudge-response` : enregistre `nudge_response`/`nudge_responded_at`, ne modifie jamais `account_converted`/`resolved_via` dans `supabase/tests/playbook-execute.test.ts`
- [ ] T027 [P] [US4] Test `nudge-response` sur exécution non exécutée (`executed_at IS NULL`) → `409` dans `supabase/tests/playbook-execute.test.ts`

### Implementation for User Story 4

- [ ] T028 [US4] Implémenter `deriveAttributionStatus` (déjà créé en T004) et l'exposer via `GET /playbook-execute/{id}/attribution-status` dans `supabase/functions/playbook-execute/index.ts` (dépend de T004, T009)
- [ ] T029 [US4] Implémenter `supabase/functions/playbook-outcome-stats/index.ts` (`GET /playbook-outcome-stats?playbook_id=`) : agrégation SQL groupée par `executed_at IS NOT NULL` (cf. data-model.md), calcul `resolution_rate`/`sample_size_warning` côté applicatif (dépend de T002)
- [ ] T030 [US4] Implémenter l'action `nudge-response` dans `supabase/functions/playbook-execute/index.ts` : validation `executed_at IS NOT NULL` (409 sinon) → écriture `nudge_response`/`nudge_responded_at`, sans toucher `account_converted`/`resolved_via` (dépend de T009)
- [ ] T031 [US4] Enregistrer `playbook-outcome-stats` dans `supabase/config.toml`

**Checkpoint**: Les 4 user stories forment la boucle de preuve complète alignée sur les dépendances frontend.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T032 [P] Exécuter `npm run verify` (typecheck + lint + test + build)
- [ ] T033 Exécuter manuellement les scénarios de `quickstart.md` (5 scénarios + validation Zero-PII globale)
- [ ] T034 [P] Revue Zero-PII finale sur `playbook_execution_clicks` et tous les logs produits par ce chantier (`grep` email/nom/téléphone/IP)
- [ ] T035 Revue de diff dédiée sur `stripe-webhook/index.ts` (T015) confirmant qu'aucune ligne de `handleInvoiceEvent` n'a été modifiée — uniquement l'ajout du hook fire-and-forget

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)** : aucune dépendance.
- **Foundational (Phase 2)** : dépend de Setup — **bloque** US1 à US4.
- **US1 (Phase 3)** : dépend de Foundational uniquement.
- **US2 (Phase 4)** : dépend de Foundational uniquement ; T015 dépend de T014. Indépendante de US1 en implémentation (mais US1 doit exister pour que US2 ait des exécutions marquées à résoudre en test end-to-end).
- **US3 (Phase 5)** : dépend de Foundational uniquement. Indépendante de US1/US2.
- **US4 (Phase 6)** : dépend de Foundational (T004) et de T009 (US1) pour `attribution-status`/`nudge-response` ; `playbook-outcome-stats` (T029) dépend uniquement de Foundational.
- **Polish (Phase 7)** : dépend de toutes les stories désirées.

### Parallel Opportunities

- T005-T008, T008A (tests US1) en parallèle.
- T010-T013 (tests US2) en parallèle.
- T017-T021 (tests US3) en parallèle.
- T024-T027 (tests US4) en parallèle.
- US3 (Phase 5) peut être menée en parallèle de US1/US2 (Phases 3-4) une fois la Phase 2 terminée.

---

## Parallel Example: User Story 2

```bash
Task: "Test playbook-outcome-detector : résolution dans la fenêtre dans supabase/tests/playbook-outcome-detector.test.ts"
Task: "Test playbook-outcome-detector : fenêtre expirée dans supabase/tests/playbook-outcome-detector.test.ts"
Task: "Test playbook-outcome-detector : multi-exécutions dans supabase/tests/playbook-outcome-detector.test.ts"
Task: "Test non-régression handleInvoiceEvent dans supabase/tests/stripe-webhook.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 + User Story 2)

1. Phase 1 (Setup) → Phase 2 (Foundational) → Phase 3 (US1) → Phase 4 (US2).
2. **STOP et VALIDER** : boucle de preuve minimale fonctionnelle (marquage + résolution auto), **avec validation utilisateur explicite de T015 avant toute exécution de cette tâche** (point de gouvernance).
3. US3 et US4 sont des enrichissements livrables séparément après.

### Livraison incrémentale

1. Setup + Foundational → fondation prête.
2. US1 → marquage manuel fonctionnel.
3. US2 → détection automatique (MVP boucle de preuve) — **valider T015 avec l'utilisateur avant de l'exécuter**.
4. US3 → lien traçable + clics — **valider T022 avec l'utilisateur avant de l'exécuter**.
5. US4 → lecture d'état, stats, nudge — complète les dépendances frontend.

---

## Notes

- [P] = fichiers différents, aucune dépendance croisée.
- **T015 et T022 sont explicitement marquées comme nécessitant une validation utilisateur avant exécution** — ne pas les traiter comme des tâches ordinaires même en mode d'implémentation autonome.
- Vérifier que chaque test échoue avant l'implémentation correspondante.
- Committer après chaque tâche ou groupe logique, Conventional Commits (cf. CLAUDE.md § Git).
