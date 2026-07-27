# Implementation Plan: Boucle de preuve de résultat des playbooks (backend)

**Branch**: `feat/playbook-outcome-tracking` | **Date**: 2026-07-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-playbook-outcome-tracking/spec.md`

## Summary

Ajouter le marquage manuel "exécuté" d'une exécution de playbook avec fenêtre d'attribution configurable, une détection automatique de résolution en étendant (de façon strictement additive et fire-and-forget) le traitement `invoice.paid` déjà existant dans `stripe-webhook`, et un lien traçable optionnel avec log de clic Zero-PII (`playbook_execution_clicks`). Aucun nouveau pipeline de synchronisation Stripe, réutilisation exclusive de l'existant.

**Alignement frontend (2026-07-26)** : ajout de trois dépendances identifiées par le frontend, comblant des manques du plan initial — (1) un endpoint de lecture d'état/durée de la fenêtre d'attribution après le marquage initial, (2) un endpoint de taux de résolution exécuté vs non-exécuté avec taille d'échantillon (seuil de fiabilité `< 20`, aligné sur la convention déjà retenue pour les benchmarks du chantier A), (3) le stockage de la réponse à un nudge de confirmation (`nudge_response`/`nudge_responded_at` sur `playbook_executions`). Détail complet dans `data-model.md` et `contracts/playbook-outcome-api.md`.

## Technical Context

**Language/Version**: TypeScript 5.x, runtime Deno (Edge Functions Supabase).

**Primary Dependencies**: `_shared/supabase-client.ts`, `_shared/auth.ts`, code existant de `stripe-webhook/index.ts` (`handleInvoiceEvent`), pattern fire-and-forget déjà utilisé pour `invoice.payment_failed` → `playbook-executor`.

**Storage**: Supabase PostgreSQL — extension de `playbooks` (+1 colonne) et `playbook_executions` (+4 colonnes : `attribution_deadline_at`, `resolved_via`, `nudge_response`, `nudge_responded_at`), nouvelle table `playbook_execution_clicks`. Le taux de résolution exécuté vs non-exécuté et le statut d'attribution sont des agrégats/champs dérivés calculés à la lecture, pas de nouvelle table.

**Testing**: Vitest — tests unitaires sur le calcul de `attribution_deadline_at`, la sélection des exécutions "en attente d'attribution", l'idempotence du marquage exécuté, le calcul de `attribution_status` dérivé, l'agrégation exécuté/non-exécuté avec `sample_size_warning`, et un test Zero-PII explicite sur le contenu de `playbook_execution_clicks`.

**Target Platform**: Supabase Edge Functions (Deno).

**Project Type**: Extension backend d'un projet web existant — pas de nouveau projet.

**Performance Goals**: Le hook fire-and-forget ajouté au webhook Stripe ne doit ajouter aucune latence perceptible au traitement existant de `invoice.paid` (appel non-bloquant, cohérent avec le pattern déjà en place pour `invoice.payment_failed`).

**Constraints**: FR-005 (non-régression stricte du traitement existant `invoice.paid`) ; Zero-PII strict sur `playbook_execution_clicks` ; `organization_id` obligatoire sur toute nouvelle donnée ; la destination de redirection du lien traçable DOIT être résolue côté serveur (pas de paramètre arbitraire) pour éviter tout open-redirect.

**Scale/Scope**: Volume proportionnel aux exécutions de playbooks déjà existantes — pas de changement d'échelle notable.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principe (constitution) | Statut | Justification |
|---|---|---|
| I. Zero-PII | ✅ PASS | `playbook_execution_clicks` ne contient que `stripe_customer_id`/`organization_id`/horodatages — aucune PII, conforme FR-008. |
| II. RLS obligatoire | ✅ PASS | RLS org_isolation sur `playbook_execution_clicks`, cohérent avec les tables existantes. |
| III. Multi-tenant strict | ✅ PASS | `organization_id` obligatoire sur la nouvelle table et sur les requêtes de détection/marquage. |
| IV. Identifiants et schéma | ✅ PASS | UUID PK, `created_at` sur la nouvelle table (pas de `updated_at` nécessaire — table de log append-only, cohérent avec `outbound_webhook_logs`). |
| V. Migrations sûres | ✅ PASS | Migration additive (`ALTER TABLE ADD COLUMN`, `CREATE TABLE`), aucun `DROP`. |
| VI. Gestion des secrets | ✅ PASS (N/A) | Aucun nouveau secret — appel interne service_role déjà en place pour ce pattern. |
| VII. Conventions | ✅ PASS | `snake_case`, TypeScript strict, Deno. |
| VIII. Modifications ciblées | ⚠️ Point d'attention | Le hook fire-and-forget dans `stripe-webhook/index.ts` doit être un ajout ciblé (str_replace) au `switch` existant sur `invoice.paid`, **jamais** une réécriture de `handleInvoiceEvent` — à respecter strictement en implémentation (FR-005). |
| Gouvernance changements sensibles | ⚠️ Rappel explicite | Ce chantier modifie un fichier qui gère RLS/multi-tenant de façon indirecte (`stripe-webhook`) et introduit une route publique sans auth (`/playbook-link/{execution_id}`). **Validation utilisateur explicite requise avant `/speckit-implement`** sur : (a) le diff exact du hook ajouté dans `stripe-webhook/index.ts`, (b) la conception anti-open-redirect de `/playbook-link`. |

Aucune violation bloquante — deux points d'attention documentés ci-dessus, cohérents avec la clause de gouvernance de la constitution (validation explicite requise, pas un blocage du plan lui-même).

## Project Structure

### Documentation (this feature)

```text
specs/002-playbook-outcome-tracking/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── playbook-outcome-api.md
└── tasks.md   # Phase 2 (/speckit-tasks — PAS généré par ce plan)
```

### Source Code (repository root)

```text
supabase/
├── functions/
│   ├── stripe-webhook/
│   │   └── index.ts                    # MODIFIÉ — ajout ciblé (str_replace) : hook fire-and-forget après le cas 'invoice.paid' existant
│   ├── playbook-outcome-detector/       # NOUVEAU — Edge Function interne (service_role), marque les exécutions résolues
│   │   └── index.ts
│   ├── playbook-link/                   # NOUVEAU — Edge Function publique, log de clic + redirection 302
│   │   └── index.ts
│   ├── playbook-execute/
│   │   └── index.ts                    # MODIFIÉ (ou nouvel endpoint dédié) — ajout des actions "mark-executed", "attribution-status" (GET), "nudge-response"
│   ├── playbook-outcome-stats/           # NOUVEAU — Edge Function GET, agrégation exécuté vs non-exécuté par playbook
│   │   └── index.ts
│   └── _shared/
│       └── playbook-engine.ts           # MODIFIÉ (ajout ciblé) — helpers calcul attribution_deadline_at, statut dérivé attribution_status, sélection exécutions en attente
├── migrations/
│   └── <timestamp>_playbook_outcome_tracking.sql   # NOUVEAU — colonnes playbooks/playbook_executions (+ nudge_response/nudge_responded_at) + table playbook_execution_clicks + RLS
└── tests/
    ├── playbook-outcome-detector.test.ts   # NOUVEAU
    ├── playbook-outcome-stats.test.ts       # NOUVEAU — agrégation, sample_size_warning, division par zéro
    ├── playbook-link.test.ts               # NOUVEAU
    └── playbook-execute.test.ts             # MODIFIÉ — cas mark-executed, attribution-status, nudge-response
```

**Structure Decision**: Extension du monorepo existant. Décidé (2026-07-27, cf. `API_CONTRACTS.md` § 8.1) : `mark-executed` est une sous-route dédiée sur la fonction `playbook-execute` existante (`POST /playbook-execute/{execution_id}/mark-executed`, routage par path), **distincte** du corps `POST /playbook-execute` (déclenchement d'actions automatisées). Ce choix évite de réutiliser l'endpoint de déclenchement — via `execution_source: "manual"` — pour un marquage déclaratif a posteriori, ce qui risquerait de redéclencher des actions réelles (email, HubSpot) au lieu de simplement enregistrer que le CSM a agi manuellement. Ce plan pose par ailleurs la contrainte de non-régression (FR-005) et de modification ciblée sur `stripe-webhook`.

**Point de vigilance explicite pour `/speckit-tasks`** : toute tâche touchant `stripe-webhook/index.ts` doit être formulée comme une modification ciblée additive, avec un rappel explicite de la clause de gouvernance de la constitution nécessitant validation utilisateur avant implémentation de cette tâche spécifique.

## Complexity Tracking

Aucune violation constitutionnelle bloquante. Les deux points d'attention (modification `stripe-webhook`, endpoint public sans auth) sont documentés dans Constitution Check ci-dessus, pas dans cette section (ce ne sont pas des violations, mais des points nécessitant validation explicite conformément à la constitution elle-même).
