# Implementation Plan: Mise en œuvre technique du pricing (backend)

**Branch**: `feat/pricing-billing-implementation` | **Date**: 2026-07-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-pricing-billing-implementation/spec.md`

## Summary

Implémenter le gating par palier tarifaire (Free/Growth/Scale/Enterprise) basé sur le nombre de comptes actifs suivis, une intégration Stripe Billing **entièrement distincte** de l'intégration Stripe existante (qui lit les données des clients de chaque organisation) pour facturer Sentio lui-même, et un parcours self-serve par défaut pour Free/Growth avec proposition d'appel non-bloquante au moment de la connexion de la clé Stripe — RDV obligatoire sans alternative pour Scale/Enterprise.

**Point d'architecture central** : ce chantier introduit une deuxième intégration Stripe complètement séparée (comptes, clés, webhooks, tables) de celle déjà en production pour les données clients. Toute confusion entre les deux serait une faille de sécurité/facturation — voir Constitution Check et research.md.

## Technical Context

**Language/Version**: TypeScript 5.x, runtime Deno (Edge Functions Supabase).

**Primary Dependencies**: SDK Stripe (déjà une dépendance du projet pour l'intégration client existante — même package, nouvelle instance avec des identifiants Sentio dédiés), `_shared/supabase-client.ts`, `_shared/auth.ts`.

**Storage**: Supabase PostgreSQL — nouvelles tables `sentio_subscriptions`, `pricing_tier_limits` ; extension de la CHECK constraint `organizations.plan_type`.

**Testing**: Vitest — tests unitaires sur `checkAccountLimitGate()`, le calcul du seuil d'alerte, la validation de downgrade incohérent, et un test explicite vérifiant qu'aucun identifiant/table de l'intégration Stripe client n'est référencé par le code de facturation Sentio (garde-fou de séparation).

**Target Platform**: Supabase Edge Functions (Deno) + compte Stripe dédié à la facturation Sentio (nouvel environnement de configuration, hors client).

**Project Type**: Extension backend d'un projet web existant — pas de nouveau projet, mais nouvelle intégration externe (deuxième compte Stripe).

**Performance Goals**: Le calcul de `active_accounts_count` (COUNT simple sur `accounts`) doit rester compatible avec un appel synchrone `<5s` dans `GET /pricing-status`, cohérent avec le contrat Edge Function standard.

**Constraints**: Séparation stricte des deux intégrations Stripe (comptes, secrets, webhooks, tables — aucune mutualisation au-delà du SDK) ; `organization_id` obligatoire sur `sentio_subscriptions` ; aucun self-serve pour Scale/Enterprise (FR-012) ; RDV-optionnel Free/Growth actif par défaut, sans feature flag (le chantier A étant confirmé livré).

**Scale/Scope**: Une ligne `sentio_subscriptions` par organisation cliente de Sentio — volume very small (nombre d'organisations clientes de Sentio, pas de leurs propres clients).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principe (constitution) | Statut | Justification |
|---|---|---|
| I. Zero-PII | ✅ PASS | `sentio_subscriptions` ne contient que des identifiants Stripe et des métadonnées d'abonnement, aucune PII personnelle. |
| II. RLS obligatoire | ✅ PASS | RLS org_isolation sur `sentio_subscriptions` ; `pricing_tier_limits` est une table de référence globale sans PII, pas de RLS org-scopée nécessaire (lecture seule authentifiée). |
| III. Multi-tenant strict | ✅ PASS | `organization_id` obligatoire et UNIQUE sur `sentio_subscriptions`. |
| IV. Identifiants et schéma | ✅ PASS | UUID PK, `created_at`/`updated_at` sur les nouvelles tables. |
| V. Migrations sûres | ⚠️ Point d'attention | L'élargissement de la CHECK constraint `organizations.plan_type` (suppression de `starter`) doit être vérifié contre les données existantes avant migration — si des organisations sont déjà sur `starter`, une décision de mapping (ex: `starter` → `growth`) doit être validée explicitement avant d'exécuter la migration, pas décidée silencieusement en implémentation. Migration additive sinon (`ADD COLUMN`/`CREATE TABLE`), aucun `DROP`. |
| VI. Gestion des secrets | ✅ PASS (nouveaux secrets nécessaires) | Nouvelles variables d'environnement dédiées à la facturation Sentio (ex. `SENTIO_BILLING_STRIPE_SECRET_KEY`, `SENTIO_BILLING_STRIPE_WEBHOOK_SECRET`), strictement distinctes de `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` existants — jamais en dur, via Vault/env comme le reste du produit. |
| VII. Conventions | ✅ PASS | `snake_case`, TypeScript strict, Deno. |
| VIII. Modifications ciblées | ✅ PASS | Nouvelles tables et nouvelles Edge Functions dédiées ; seule modification d'un fichier existant : extension ciblée de `onboarding-status` (ajout d'un champ) et de `on-user-signup`/`create-organization-with-invitation` si le palier par défaut doit changer de nom. |
| Gouvernance changements sensibles | ⚠️ Rappel explicite | Ce chantier ne touche pas RLS/helpers existants mais introduit une architecture de facturation externe critique. **Validation utilisateur explicite requise avant `/speckit-implement`** sur : (a) la stricte séparation des deux intégrations Stripe (noms de variables, comptes Stripe, endpoints), (b) la politique de migration `starter → ?` si des données existantes sont concernées, (c) le mécanisme choisi pour l'alerte de limite (`ai_insights` vs nouveau canal, cf. research.md). |

Aucune violation bloquante. Trois points d'attention explicitement signalés ci-dessus, à confirmer avant `/speckit-tasks`/`/speckit-implement` — cohérent avec la clause de gouvernance de la constitution, pas un blocage du plan lui-même.

## Project Structure

### Documentation (this feature)

```text
specs/003-pricing-billing-implementation/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── pricing-billing-api.md
└── tasks.md   # Phase 2 (/speckit-tasks — PAS généré par ce plan)
```

### Source Code (repository root)

```text
supabase/
├── functions/
│   ├── pricing-status/              # NOUVEAU — GET, calcul gating + alerte
│   │   └── index.ts
│   ├── sentio-billing-subscribe/    # NOUVEAU — POST, création/changement/annulation abonnement Sentio
│   │   └── index.ts
│   ├── sentio-billing-webhook/      # NOUVEAU — webhook dédié, compte Stripe Sentio, secret distinct
│   │   └── index.ts
│   ├── onboarding-status/
│   │   └── index.ts                # MODIFIÉ (ajout ciblé) — champ show_call_prompt
│   └── _shared/
│       └── pricing.ts               # NOUVEAU — checkAccountLimitGate(), calcul seuil alerte, validation downgrade (fonctions pures)
├── migrations/
│   └── <timestamp>_pricing_billing_implementation.sql   # NOUVEAU — pricing_tier_limits, sentio_subscriptions, ALTER organizations.plan_type CHECK
└── tests/
    ├── pricing.test.ts                    # NOUVEAU — fonctions pures _shared/pricing.ts
    ├── pricing-status.test.ts             # NOUVEAU
    ├── sentio-billing-subscribe.test.ts   # NOUVEAU
    ├── sentio-billing-webhook.test.ts     # NOUVEAU
    └── onboarding-status.test.ts          # MODIFIÉ — cas show_call_prompt
```

**Structure Decision**: Extension du monorepo existant avec un sous-ensemble d'Edge Functions clairement préfixées/nommées pour signaler leur appartenance au domaine "facturation Sentio" (`sentio-billing-*`), séparé sans ambiguïté du domaine "données clients" (`stripe-*`, `sync-stripe`). Aucun fichier du domaine `stripe-*` existant n'est modifié par ce chantier, à l'exception de la CHECK constraint `organizations.plan_type` (donnée d'organisation, pas de webhook).

**Rappel pour `/speckit-tasks`** : toute tâche de ce chantier doit explicitement nommer "Sentio billing" vs "client Stripe data" dans son titre pour éviter toute ambiguïté lors de l'implémentation ultérieure.

## Complexity Tracking

Aucune violation constitutionnelle bloquante. Les trois points d'attention (migration `plan_type`, secrets dédiés, mécanisme d'alerte) sont documentés dans Constitution Check ci-dessus — décisions à valider explicitement, pas des violations à justifier ici.
