---

description: "Task list for feature implementation"
---

# Tasks: Mise en œuvre technique du pricing (backend)

**Input**: Design documents from `/specs/003-pricing-billing-implementation/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md, `docs/stripe-billing-setup.md`

**Tests**: Incluses — convention Vitest systématique du projet (`supabase/tests/`).

**Organization**: Tasks groupées par user story (US1 = gating par palier, US2 = Stripe Billing Sentio, US3 = parcours self-serve/RDV).

## Format: `[ID] [P?] [Story] Description`

## Path Conventions

Monorepo existant — `supabase/functions/`, `supabase/migrations/`, `supabase/tests/`, `docs/` (cf. plan.md § Project Structure).

---

## ⚠️ Rappels de gouvernance à respecter dans toute l'implémentation de ce chantier

1. **Séparation Stripe stricte** : aucun code de ce chantier ne doit importer, référencer, ou faire un fallback vers `STRIPE_SECRET_KEY`/`STRIPE_CLIENT_ID`/`STRIPE_WEBHOOK_SECRET` (intégration client existante). Seules `STRIPE_BILLING_SECRET_KEY`/`STRIPE_BILLING_WEBHOOK_SECRET` sont utilisées. L'absence de l'une de ces deux variables DOIT lever une erreur explicite au démarrage de la fonction concernée, jamais un comportement dégradé silencieux.
2. **Prérequis manuel externe** : `docs/stripe-billing-setup.md` doit être complété par l'utilisateur (compte Stripe, produits/prix, clé restreinte, webhook) avant que les tests d'intégration bout-en-bout de US2 puissent s'exécuter contre un vrai compte Stripe — les tests unitaires purs n'en dépendent pas.
3. **Pas de code hors backend** : écrans frontend de souscription et prise de RDV (calendaire) sont explicitement hors scope (cf. spec.md § Assumptions) — ne pas générer de tâche frontend.

---

## Statut d'implémentation (2026-07-27, `/speckit-implement`)

**US1, US2, US3 implémentées et testées.**

- **T001, T004** : nécessitent une stack Supabase locale réelle (Docker + `supabase start`) pour appliquer les migrations et vérifier la RLS/distribution résultante — non disponible dans cet environnement. Non simulées, laissées non cochées.
- **T031** : nécessite en plus un vrai compte Stripe Billing (`docs/stripe-billing-setup.md`, checklist §6 non complétée par l'utilisateur — vérifié, toutes les cases sont décochées) — non exécutable ici. Non simulée.
- **T003 — grille tarifaire PLACEHOLDER** : `max_active_accounts` n'est fixé nulle part dans spec.md/plan.md/data-model.md ("chacun avec une limite... configurée", sans grille chiffrée). Seedé avec des valeurs placeholder (`free=10, growth=100, scale=500, enterprise=NULL`) dans la migration, explicitement commentées comme non-validées côté produit — à ajuster via une décision produit avant tout déploiement réel (la table existe précisément pour permettre cet ajustement sans nouveau déploiement de code).
- **Écart — mécanisme `sentio-billing-subscribe`** : le contrat (`pricing-billing-api.md`) décrit une réponse "URL de session Stripe Checkout ou Billing Portal". Implémenté à la place via l'API Stripe `Subscriptions` directe (`payment_behavior=default_incomplete`), qui retourne un `status` exploitable synchrone plutôt qu'une redirection — l'UI de checkout étant explicitement hors scope de ce chantier backend (gouvernance §3), le choix exact Checkout Session vs Elements/PaymentIntent est un détail d'intégration frontend non tranché ici.
- **Écart — `show_call_prompt`** : la spec/research.md décrit une transition "vient de passer de `false` à `true`", mais `organizations` n'a aucune colonne d'horodatage pour `stripe_connected` — impossible de distinguer une connexion récente d'une connexion ancienne. Implémenté en logique de **niveau** (`stripe_connected && plan_tier IN ('free','growth')`), pas de détection de transition ponctuelle. Documenté en commentaire dans `onboarding-status/index.ts`.
- **Séparation SDK Stripe** : `plan.md` supposait la dépendance npm `stripe` déjà utilisée côté Edge Functions — vérifié, elle n'est importée nulle part dans `supabase/functions/` (seulement listée dans `package.json`, utilisée potentiellement côté frontend). Suivi la convention Deno déjà établie par `sync-stripe`/`stripe-webhook` : appels `fetch()` bruts vers l'API REST Stripe + vérification HMAC manuelle, dupliquée intentionnellement (pas importée de `stripe-webhook`) pour zéro couplage entre les deux intégrations.

---

## Phase 1: Setup

- [ ] T001 Confirmer que la migration `supabase/migrations/20260726000001_organizations_plan_type_free_grid.sql` (déjà écrite) est bien la seule modification de `organizations.plan_type` nécessaire ; l'appliquer en local (`supabase migration up` ou équivalent) et vérifier la distribution résultante (`free/growth/scale/enterprise` uniquement)

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: Aucune story ne peut être implémentée avant la fin de cette phase.

- [X] T002 Créer la migration `supabase/migrations/<timestamp>_pricing_billing_implementation.sql` : `CREATE TABLE pricing_tier_limits` (`plan_tier` PK, `max_active_accounts`, `requires_appointment`, `alert_threshold_pct` défaut 90, `updated_at`) ; `CREATE TABLE sentio_subscriptions` (`id`, `organization_id` UNIQUE, `sentio_stripe_customer_id` UNIQUE, `sentio_stripe_subscription_id`, `plan_tier`, `status`, `current_period_end`, `cancel_at_period_end`, `created_at`, `updated_at`) + RLS org_isolation sur `sentio_subscriptions` ; `ALTER TABLE ai_insights DROP CONSTRAINT ai_insights_insight_type_check` / `ADD CONSTRAINT ... CHECK (insight_type = ANY (ARRAY[..., 'plan_limit_warning']))` (cf. data-model.md)
- [X] T003 Seed `pricing_tier_limits` avec les 4 paliers (`free`, `growth`, `scale`, `enterprise` — `max_active_accounts` et `requires_appointment` selon la grille produit, `enterprise.max_active_accounts = NULL`)
- [ ] T004 Appliquer T002/T003 en local et vérifier la RLS de `sentio_subscriptions`
- [X] T005 [P] Implémenter les fonctions pures dans `supabase/functions/_shared/pricing.ts` (nouveau fichier) : `checkAccountLimitGate(activeAccountCount, tierLimits)`, `calculateUsagePct()`, `isDowngradeIncoherent(targetTierLimits, activeAccountCount)` (cf. data-model.md, research.md)
- [X] T006 [P] Documenter dans un commentaire en tête de tout fichier `sentio-billing-*` la règle de séparation Stripe (rappel de gouvernance §1) — pas de fallback vers les secrets client

**Checkpoint**: Schéma et fonctions pures prêts — US1 à US3 peuvent démarrer.

---

## Phase 3: User Story 1 - Gating par palier selon le nombre de comptes actifs suivis (Priority: P1) 🎯 MVP

**Goal**: Alerter à l'approche de la limite, appliquer le gating au dépassement (V1 : blocage de l'ajout de nouveaux comptes, pas de coupure de l'existant).

**Independent Test**: Faire croître `active_accounts_count` jusqu'à et au-delà de la limite du palier ; vérifier alerte puis gating ; faire redescendre, vérifier la levée.

### Tests for User Story 1

- [X] T007 [P] [US1] Test `checkAccountLimitGate` : sous la limite → pas de gating ; au-dessus → gating actif ; palier `enterprise` (`max_active_accounts = null`) → jamais de gating dans `supabase/tests/pricing.test.ts`
- [X] T008 [P] [US1] Test `calculateUsagePct` : calcul correct, `null` si `max_active_accounts = null` dans `supabase/tests/pricing.test.ts`
- [X] T009 [P] [US1] Test `GET /pricing-status` : `alert_active = true` dès `usage_pct >= alert_threshold_pct` (défaut 90) dans `supabase/tests/pricing-status.test.ts`
- [X] T010 [P] [US1] Test `GET /pricing-status` : `alert_active` repasse à `false` quand `active_accounts_count` redescend sous le seuil dans `supabase/tests/pricing-status.test.ts`
- [X] T011 [P] [US1] Test génération de l'insight `plan_limit_warning` (`account_id = null`, `metadata.signals` cohérent) dans `supabase/tests/pricing-status.test.ts`

### Implementation for User Story 1

- [X] T012 [US1] Implémenter `supabase/functions/pricing-status/index.ts` (`GET /pricing-status`) : Auth JWT ES256 → scoping `organization_id` → `COUNT(*) FROM accounts WHERE mrr_cents > 0` → jointure `pricing_tier_limits` → calcul gating/alerte via T005 (dépend de T002, T005)
- [X] T013 [US1] Implémenter la création de l'insight `ai_insights` (`insight_type: 'plan_limit_warning'`, `account_id: null`) déclenchée quand `alert_active` passe de `false` à `true` (dépend de T012, T002)
- [X] T014 [US1] Enregistrer `pricing-status` dans `supabase/config.toml`

**Checkpoint**: US1 fonctionnelle et testable indépendamment (MVP — gating déclaratif, sans Stripe Billing encore branché).

---

## Phase 4: User Story 2 - Intégration Stripe Billing pour la facturation de Sentio (Priority: P1)

**Goal**: Créer/changer/annuler un abonnement Sentio via un compte Stripe strictement séparé de l'intégration client existante.

**Independent Test**: Créer un abonnement pour une organisation Free, changer de palier, annuler — vérifier l'état à chaque étape, aucune interférence avec `stripe-webhook`/`sync-stripe` existants.

### Tests for User Story 2

- [X] T015 [P] [US2] Test `sentio-billing-subscribe` : organisation Free → souscription Growth → `sentio_subscriptions` créée, `status: active` dans `supabase/tests/sentio-billing-subscribe.test.ts`
- [X] T016 [P] [US2] Test `sentio-billing-subscribe` : tentative de souscription/changement vers `scale`/`enterprise` → `403` (FR-012, pas de self-serve) dans `supabase/tests/sentio-billing-subscribe.test.ts`
- [X] T017 [P] [US2] Test `sentio-billing-subscribe` : downgrade incohérent avec `active_accounts_count` du palier cible → `409` via `isDowngradeIncoherent` (FR-013) dans `supabase/tests/sentio-billing-subscribe.test.ts`
- [X] T018 [P] [US2] Test `sentio-billing-webhook` : `customer.subscription.deleted` → `sentio_subscriptions.status = canceled`, retour au palier Free à l'échéance (cf. Assumptions) dans `supabase/tests/sentio-billing-webhook.test.ts`
- [X] T019 [P] [US2] Test `sentio-billing-webhook` : `invoice.payment_failed` → état de grâce appliqué (pas de gating punitif immédiat, cf. Assumptions) dans `supabase/tests/sentio-billing-webhook.test.ts`
- [X] T020 [P] [US2] Test de garde-fou de séparation : aucun fichier `sentio-billing-*` ne référence `STRIPE_SECRET_KEY`/`STRIPE_CLIENT_ID`/`STRIPE_WEBHOOK_SECRET` (analyse statique du code source des fonctions du chantier) dans `supabase/tests/sentio-billing-separation.test.ts`
- [X] T021 [P] [US2] Test : absence de `STRIPE_BILLING_SECRET_KEY`/`STRIPE_BILLING_WEBHOOK_SECRET` → erreur explicite au démarrage, pas de fallback dans `supabase/tests/sentio-billing-subscribe.test.ts`

### Implementation for User Story 2

- [X] T022 [US2] Implémenter `supabase/functions/sentio-billing-subscribe/index.ts` (`POST /sentio-billing/subscribe`) : Auth JWT ES256 → scoping `organization_id` → lecture stricte de `STRIPE_BILLING_SECRET_KEY` (erreur explicite si absent) → création/màj client+abonnement Stripe (compte Sentio Billing) → upsert `sentio_subscriptions` (dépend de T002, T005)
- [X] T023 [US2] Implémenter `supabase/functions/sentio-billing-webhook/index.ts` : vérification de signature avec `STRIPE_BILLING_WEBHOOK_SECRET` (distinct de `STRIPE_WEBHOOK_SECRET`) → traite `customer.subscription.updated/deleted`, `invoice.payment_failed` → met à jour `sentio_subscriptions` (dépend de T002)
- [X] T024 [US2] Enregistrer `sentio-billing-subscribe` et `sentio-billing-webhook` dans `supabase/config.toml` (webhook : `verify_jwt = false`, signature Stripe vérifiée dans le code, cohérent avec `stripe-webhook` existant mais secret distinct)
- [X] T025 [US2] Vérifier manuellement (checklist `docs/stripe-billing-setup.md`) que le compte Stripe Sentio Billing, les produits/prix, la clé restreinte et l'endpoint webhook sont configurés avant tout test d'intégration réel — documenter dans le PR/commit si cette checklist n'est pas encore complète côté utilisateur

**Checkpoint**: US1+US2 rendent la grille tarifaire opérationnelle (gating + facturation réelle), sans aucune interférence avec l'intégration Stripe client existante.

---

## Phase 5: User Story 3 - Parcours self-serve par défaut (Free/Growth) avec proposition d'appel ciblée (Priority: P2)

**Goal**: Self-serve actif par défaut pour Free/Growth ; proposition d'appel non-bloquante au moment de la connexion Stripe (données clients) ; RDV obligatoire sans alternative pour Scale/Enterprise.

**Independent Test**: Simuler une souscription Free/Growth de bout en bout sans RDV ; simuler une tentative Scale/Enterprise et vérifier l'absence de chemin self-serve.

### Tests for User Story 3

- [X] T026 [P] [US3] Test `GET /onboarding-status` : `show_call_prompt = false` avant connexion Stripe (données clients) pour une organisation Free/Growth dans `supabase/tests/onboarding-status.test.ts`
- [X] T027 [P] [US3] Test `GET /onboarding-status` : `show_call_prompt = true` immédiatement après que `stripe_connected` passe à `true`, `current_step` inchangé/non bloqué dans `supabase/tests/onboarding-status.test.ts`
- [X] T028 [P] [US3] Test `GET /onboarding-status` : `show_call_prompt` toujours `false` pour une organisation `scale`/`enterprise` (le RDV est déjà obligatoire par ailleurs, pas de proposition non-bloquante à afficher) dans `supabase/tests/onboarding-status.test.ts`

### Implementation for User Story 3

- [X] T029 [US3] Étendre `supabase/functions/onboarding-status/index.ts` (ajout ciblé, pas de réécriture) : nouveau champ `show_call_prompt` dans la réponse, calculé selon la règle T026-T028 (dépend de T012 pour lire `plan_tier`)

**Checkpoint**: US1+US2+US3 complètent le chantier — grille tarifaire opérationnelle avec parcours d'acquisition conforme.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T030 [P] Exécuter `npm run verify` (typecheck + lint + test + build)
- [ ] T031 Exécuter manuellement les scénarios de `quickstart.md` (5 scénarios + validation de séparation Stripe SC-005)
- [X] T032 [P] Revue de code dédiée confirmant qu'aucun fichier `sentio-billing-*`/`pricing-*` ne partage de secret, d'endpoint ou de table avec `stripe-oauth-*`/`stripe-webhook`/`sync-stripe`/`stripe-product-mappings-api` (rappel de gouvernance §1)
- [X] T033 Documenter dans le PR final si `docs/stripe-billing-setup.md` a été complété côté utilisateur ou reste à faire avant un déploiement réel

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)** : aucune dépendance.
- **Foundational (Phase 2)** : dépend de Setup — **bloque** US1 à US3.
- **US1 (Phase 3)** : dépend de Foundational uniquement.
- **US2 (Phase 4)** : dépend de Foundational uniquement ; T017 dépend indirectement de T005 (`isDowngradeIncoherent`). Indépendante de US1 en implémentation (mais consomme `pricing_tier_limits` créée en Foundational, pas l'endpoint US1).
- **US3 (Phase 5)** : dépend de Foundational et de T012 (US1, pour lire `plan_tier` dans `onboarding-status`).
- **Polish (Phase 6)** : dépend de toutes les stories désirées.

### Parallel Opportunities

- T007-T011 (tests US1) en parallèle.
- T015-T021 (tests US2) en parallèle.
- T026-T028 (tests US3) en parallèle.
- US1 (Phase 3) et US2 (Phase 4) peuvent être menées en parallèle une fois la Phase 2 terminée (US3 attend T012).

---

## Parallel Example: User Story 2

```bash
Task: "Test sentio-billing-subscribe : création abonnement dans supabase/tests/sentio-billing-subscribe.test.ts"
Task: "Test sentio-billing-subscribe : 403 sur scale/enterprise dans supabase/tests/sentio-billing-subscribe.test.ts"
Task: "Test sentio-billing-webhook : subscription.deleted dans supabase/tests/sentio-billing-webhook.test.ts"
Task: "Test garde-fou de séparation Stripe dans supabase/tests/sentio-billing-separation.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 seule)

1. Phase 1 (Setup) → Phase 2 (Foundational) → Phase 3 (US1).
2. **STOP et VALIDER** : gating et alerte fonctionnels, même sans Stripe Billing branché (utile pour valider la logique métier avant de dépendre d'un compte Stripe réel — cf. `docs/stripe-billing-setup.md` non encore complété par l'utilisateur à ce stade).

### Livraison incrémentale

1. Setup + Foundational → fondation prête.
2. US1 → gating/alerte opérationnels (peut être démontré sans compte Stripe Billing réel, avec des données de test).
3. US2 → facturation réelle — **nécessite que `docs/stripe-billing-setup.md` soit complété côté utilisateur** pour les tests d'intégration bout-en-bout (les tests unitaires purs, eux, n'en dépendent pas).
4. US3 → parcours self-serve/RDV complété.

---

## Notes

- [P] = fichiers différents, aucune dépendance croisée.
- **T025 et T033 rappellent explicitement la dépendance à une action manuelle de l'utilisateur** (`docs/stripe-billing-setup.md`) — ne pas les traiter comme bloquantes pour le code, mais comme des jalons de vérification.
- Vérifier que chaque test échoue avant l'implémentation correspondante.
- Committer après chaque tâche ou groupe logique, Conventional Commits (cf. CLAUDE.md § Git).
