---

description: "Task list for feature implementation"
---

# Tasks: Playbooks actionnables — export CSV & bibliothèque de templates

**Input**: Design documents from `/specs/001-playbooks-export-csv/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Incluses — le projet suit déjà une convention de tests Vitest systématique (`supabase/tests/`, cf. CLAUDE.md "écrire les tests d'abord quand possible").

**Organization**: Tasks groupées par user story (US1 = export CSV, US2 = bibliothèque de templates, US3 = documentation merge-tags/ESP).

## Format: `[ID] [P?] [Story] Description`

## Path Conventions

Monorepo existant — `supabase/functions/`, `supabase/migrations/`, `supabase/tests/`, `docs/` (cf. plan.md § Project Structure).

---

## Phase 1: Setup

**Purpose**: Aucune nouvelle initialisation de projet nécessaire (extension du monorepo Supabase existant). Vérification des points d'ancrage réutilisés.

- [X] T001 Vérifier que `VALID_TEMPLATE_CATEGORIES` est exporté et stable dans `supabase/functions/_shared/playbook-engine.ts` (référence pour `template_category`, cf. research.md)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Infrastructure de données requise par US1 ET US2 avant toute implémentation.

**⚠️ CRITICAL**: Aucune story ne peut être implémentée avant la fin de cette phase.

- [X] T002 Créer la migration `supabase/migrations/<timestamp>_playbook_message_templates.sql` : table `playbook_message_templates` (`id`, `organization_id`, `template_category`, `name`, `body`, `is_active`, `is_default`, `created_at`, `updated_at`), CHECK `template_category` sur `VALID_TEMPLATE_CATEGORIES`, RLS org_isolation, index unique partiel `(organization_id, template_category) WHERE is_default = true` (cf. data-model.md)
- [ ] T003 Appliquer la migration T002 en local (`supabase migration up` ou équivalent du projet) et vérifier la RLS avec un utilisateur de test

**Checkpoint**: Table `playbook_message_templates` disponible, RLS vérifiée — US1 et US2 peuvent démarrer en parallèle.

---

## Phase 3: User Story 1 - Exporter un playbook en CSV prêt à l'emploi (Priority: P1) 🎯 MVP

**Goal**: Un CSM exporte en CSV les comptes éligibles d'un playbook, avec montant à risque et message personnalisé (merge-tags résolus), sans aucune PII.

**Independent Test**: Déclencher l'export d'un playbook actif avec comptes éligibles et vérifier les colonnes, la résolution des merge-tags, et l'absence de PII.

### Tests for User Story 1

- [X] T004 [P] [US1] Test unitaire résolution merge-tags (`{company}`, `{amount_at_risk}`, `{days_since_last_activity}`, valeur de repli si non résolvable) dans `supabase/tests/merge-tags.test.ts`
- [X] T005 [P] [US1] Test unitaire génération CSV RFC 4180 (échappement virgules/guillemets/retours ligne) dans `supabase/tests/merge-tags.test.ts`
- [X] T006 [P] [US1] Test unitaire Zero-PII sur le contenu généré (aucun email/nom/téléphone/IP) dans `supabase/tests/merge-tags.test.ts`
- [X] T007 [P] [US1] Test `playbook-export` : playbook actif avec comptes éligibles → CSV correct (colonnes `account_ref,mrr_at_risk_cents,message`) dans `supabase/tests/playbook-export.test.ts`
- [X] T008 [P] [US1] Test `playbook-export` : playbook sans compte éligible → CSV en-tête seul, `200` (Edge Case) dans `supabase/tests/playbook-export.test.ts`
- [X] T009 [P] [US1] Test `playbook-export` : aucun template actif pour la catégorie → message explicite d'absence, pas d'échec (FR-012) dans `supabase/tests/playbook-export.test.ts`
- [X] T010 [P] [US1] Test `playbook-export` : playbook inexistant ou hors organisation → `404` dans `supabase/tests/playbook-export.test.ts`

### Implementation for User Story 1

- [X] T011 [US1] Implémenter les fonctions pures de résolution de merge-tags et de génération CSV RFC 4180 dans `supabase/functions/_shared/merge-tags.ts` (dépend de T004-T006 écrits en échec)
- [X] T012 [US1] Implémenter `supabase/functions/playbook-export/index.ts` (`GET /playbook-export?playbook_id=`) : CORS → Auth JWT ES256 → scoping `organization_id` → lecture playbook + comptes éligibles via `eligibility_criteria` existant → sélection template actif (par défaut si plusieurs, cf. data-model.md) → résolution merge-tags via T011 → génération CSV → réponse `text/csv` (dépend de T011, T002)
- [X] T013 [US1] Gérer explicitement dans T012 le cas "aucun template actif" (FR-012) : message de repli explicite dans la colonne `message`, pas d'échec de requête
- [X] T014 [US1] Enregistrer `playbook-export` dans `supabase/config.toml` (`verify_jwt = false`, auth vérifiée dans le code, cohérent avec le pattern existant)

**Checkpoint**: L'export CSV est fonctionnel et testable indépendamment (MVP livrable).

---

## Phase 4: User Story 2 - Gérer une bibliothèque de templates de message par type de playbook (Priority: P2)

**Goal**: Un responsable produit crée/modifie/désactive des templates de message par catégorie de playbook, sans intervention technique.

**Independent Test**: Créer un template pour une catégorie, vérifier qu'un export de cette catégorie (US1) l'utilise ; le désactiver, vérifier qu'il n'est plus utilisé.

### Tests for User Story 2

- [X] T015 [P] [US2] Test création de template (catégorie valide, `body` non vide) dans `supabase/tests/playbook-templates-crud.test.ts`
- [X] T016 [P] [US2] Test modification (`body`, `is_active`, `is_default`, `name`) et scoping `organization_id` (un template d'une autre org n'est jamais visible/modifiable) dans `supabase/tests/playbook-templates-crud.test.ts`
- [X] T017 [P] [US2] Test contrainte "un seul `is_default=true` par `(organization_id, template_category)`" dans `supabase/tests/playbook-templates-crud.test.ts`
- [X] T018 [P] [US2] Test liste filtrable par `template_category` dans `supabase/tests/playbook-templates-crud.test.ts`

### Implementation for User Story 2

- [X] T019 [US2] Implémenter `supabase/functions/playbook-templates-crud/index.ts` (`GET`/`POST`/`PATCH /playbook-templates`) : CORS → Auth JWT ES256 → scoping `organization_id` → validation `template_category` contre `VALID_TEMPLATE_CATEGORIES` → persistance (dépend de T002)
- [X] T020 [US2] Enregistrer `playbook-templates-crud` dans `supabase/config.toml` (`verify_jwt = false`, auth dans le code)
- [X] T021 [US2] Vérifier par test d'intégration que T012 (export US1) utilise bien un template créé/modifié via T019 sans redéploiement (cf. quickstart.md Scénario 3)

**Checkpoint**: US1 et US2 fonctionnent ensemble — la bibliothèque de templates alimente l'export sans intervention technique.

---

## Phase 5: User Story 3 - Documentation de mapping des merge-tags pour import ESP (Priority: P3)

**Goal**: Documentation de référence listant les merge-tags et leur format d'import pour Brevo, Lemlist, ActiveCampaign.

**Independent Test**: Relire le document et confirmer la couverture des 3 merge-tags cités et d'au moins 2 ESP.

**Note explicite (cf. plan.md)** : livrable purement documentaire — aucune tâche de code, aucune intégration API ESP.

### Implementation for User Story 3

- [X] T022 [US3] Rédiger `docs/merge-tags-mapping.md` : tableau des merge-tags (`{company}`, `{amount_at_risk}`, `{days_since_last_activity}`) avec signification, source de donnée, valeur de repli, et syntaxe d'import équivalente pour Brevo, Lemlist et ActiveCampaign (cf. research.md § livrable documentaire)

**Checkpoint**: Documentation livrée, vérifiable indépendamment du code (US1/US2 déjà fonctionnels sans elle).

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T023 [P] Exécuter `npm run verify` (typecheck + lint + test + build) sur l'ensemble des fichiers modifiés/créés
- [ ] T024 Exécuter manuellement les scénarios de `quickstart.md` (5 scénarios) contre un environnement de test
- [X] T025 [P] Revue Zero-PII finale : `grep` sur les fichiers de test et de code pour confirmer l'absence de email/nom/téléphone/IP dans tout chemin de code de ce chantier

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)** : aucune dépendance.
- **Foundational (Phase 2)** : dépend de Setup — **bloque** US1 et US2.
- **US1 (Phase 3)** : dépend de Foundational uniquement. Peut démarrer dès T003 terminé.
- **US2 (Phase 4)** : dépend de Foundational uniquement. Indépendante de US1 (T021 est un test d'intégration croisé, pas une dépendance bloquante — US2 reste testable seule via T015-T018 avant que T012 existe).
- **US3 (Phase 5)** : aucune dépendance technique — peut démarrer en parallèle de tout le reste (documentaire pur).
- **Polish (Phase 6)** : dépend de US1+US2+US3 terminées.

### Parallel Opportunities

- T004-T010 (tests US1) en parallèle entre eux.
- T015-T018 (tests US2) en parallèle entre eux.
- US2 (Phase 4) et US3 (Phase 5) peuvent être menées en parallèle de US1 (Phase 3) une fois la Phase 2 terminée.

---

## Parallel Example: User Story 1

```bash
Task: "Test unitaire résolution merge-tags dans supabase/tests/merge-tags.test.ts"
Task: "Test unitaire génération CSV RFC 4180 dans supabase/tests/merge-tags.test.ts"
Task: "Test unitaire Zero-PII dans supabase/tests/merge-tags.test.ts"
Task: "Test playbook-export : playbook actif avec comptes éligibles dans supabase/tests/playbook-export.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 seule)

1. Phase 1 (Setup) → Phase 2 (Foundational) → Phase 3 (US1).
2. **STOP et VALIDER** : export CSV fonctionnel avec un template placeholder minimal (créé manuellement en base pour le test, avant même que US2/CRUD n'existe).
3. Démo possible à ce stade.

### Livraison incrémentale

1. Setup + Foundational → fondation prête.
2. US1 → export CSV fonctionnel (MVP).
3. US2 → bibliothèque de templates gérable côté produit (remplace la création manuelle en base).
4. US3 → documentation livrée (peut être faite à tout moment, y compris en parallèle de 2-3).

---

## Rappels de gouvernance (reportés depuis plan.md)

- Aucune tâche de ce chantier ne touche à un fichier hors de `supabase/functions/playbook-export/`, `supabase/functions/playbook-templates-crud/`, `supabase/functions/_shared/merge-tags.ts`, la nouvelle migration, les nouveaux tests, et `docs/merge-tags-mapping.md`.
- T022 (US3) ne doit produire aucun code — uniquement du contenu markdown de référence.

## Notes

- [P] = fichiers différents, aucune dépendance croisée.
- Committer après chaque tâche ou groupe logique cohérent, en respectant Conventional Commits (cf. CLAUDE.md § Git).
- Vérifier que chaque test échoue avant l'implémentation correspondante (T004-T010, T015-T018 avant T011-T012, T019).
