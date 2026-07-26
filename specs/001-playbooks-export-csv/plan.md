# Implementation Plan: Playbooks actionnables — export CSV & bibliothèque de templates

**Branch**: `feat/playbooks-export-csv` | **Date**: 2026-07-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-playbooks-export-csv/spec.md`

## Summary

Ajouter une Edge Function d'export CSV des comptes éligibles à un playbook (identifiant compte, montant à risque, message texte personnalisé), alimentée par une nouvelle bibliothèque de templates de message (`playbook_message_templates`) gérable via un endpoint CRUD dédié, plus un livrable documentaire (fichier markdown, hors code) mappant les merge-tags vers la syntaxe d'import de 2-3 ESP (Brevo, Lemlist, ActiveCampaign). Aucune donnée personnelle n'est jamais persistée ni journalisée à aucune étape.

## Technical Context

**Language/Version**: TypeScript 5.x, runtime Deno (Edge Functions Supabase) — cohérent avec la stack existante.

**Primary Dependencies**: `_shared/supabase-client.ts`, `_shared/auth.ts`, `_shared/playbook-engine.ts` (réutilisation de `VALID_TEMPLATE_CATEGORIES`, `eligibility_criteria`) — aucune nouvelle dépendance externe.

**Storage**: Supabase PostgreSQL — nouvelle table `playbook_message_templates` (RLS + `organization_id`), pas de nouvelle table pour l'export CSV (calculé à la demande, non persisté).

**Testing**: Vitest, cohérent avec `supabase/tests/` — tests unitaires purs sur la résolution des merge-tags, la sélection du template actif, et la génération CSV (échappement RFC 4180), plus un test Zero-PII explicite sur le contenu généré.

**Target Platform**: Supabase Edge Functions (Deno), appelées depuis le frontend Next.js existant.

**Project Type**: Extension backend d'un projet web existant (Edge Functions + migration SQL) — pas de nouveau projet.

**Performance Goals**: Export généré et retourné en moins de 10s pour un playbook avec plusieurs milliers de comptes éligibles (SC-001), en respectant la contrainte générale <5s de réponse Edge Function pour les volumes réalistes observés (quelques centaines de comptes par organisation) — à valider par test de charge si un cas dépasse ce volume.

**Constraints**: Zero-PII strict (aucun email/nom/téléphone/IP, à aucune étape, y compris logs) ; toute donnée personnelle en transit (si un futur merge-tag en introduisait) limitée à <500ms et jamais persistée ; `organization_id` obligatoire sur la nouvelle table et sur chaque requête.

**Scale/Scope**: Un export par playbook et par organisation, à la demande (pas de planification récurrente dans ce scope). Bibliothèque de templates : quelques dizaines de templates par organisation au maximum (une poignée par catégorie).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principe (constitution) | Statut | Justification |
|---|---|---|
| I. Zero-PII | ✅ PASS | Aucune colonne CSV ni champ de `playbook_message_templates` ne contient de PII. Merge-tags identifiés (`{company}`, `{amount_at_risk}`, `{days_since_last_activity}`) sont tous dérivés de données déjà non-PII existantes. |
| II. RLS obligatoire | ✅ PASS | `playbook_message_templates` aura RLS activé avec policy org_isolation standard, comme toutes les tables existantes. |
| III. Multi-tenant strict | ✅ PASS | `organization_id` obligatoire sur la nouvelle table et sur toute requête (export, CRUD templates). |
| IV. Identifiants et schéma | ✅ PASS | UUID PK, `created_at`/`updated_at` sur la nouvelle table. |
| V. Migrations sûres | ✅ PASS | Nouvelle migration additive (`CREATE TABLE`), aucun `DROP`. |
| VI. Gestion des secrets | ✅ PASS (N/A) | Aucun nouveau secret requis — pas d'appel externe (le mapping ESP est documentaire, pas une intégration API). |
| VII. Conventions | ✅ PASS | `snake_case` SQL/TS, TypeScript strict, Deno — conforme aux Edge Functions existantes. |
| VIII. Modifications ciblées | ✅ PASS (à respecter en implémentation) | Nouvelle table + nouvelle(s) Edge Function(s), pas de réécriture de fichiers existants au-delà d'ajouts ciblés (ex. export de `VALID_TEMPLATE_CATEGORIES` déjà public). |
| Gouvernance changements sensibles | ⚠️ Rappel | Ce chantier ne touche pas RLS existant ni aux helpers (`user_organization_id()`, `user_role()`) ni à l'architecture Zero-PII globale — il les respecte en les réutilisant. Si l'implémentation dévie de ce plan sur ces points, validation utilisateur explicite requise avant `/speckit-implement`. |

Aucune violation constitutionnelle identifiée. Pas d'entrée nécessaire dans Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/001-playbooks-export-csv/
├── plan.md              # Ce fichier
├── research.md          # Phase 0
├── data-model.md         # Phase 1
├── quickstart.md         # Phase 1
├── contracts/
│   └── playbook-export-api.md
└── tasks.md              # Phase 2 (/speckit-tasks — PAS généré par ce plan)
```

### Source Code (repository root)

```text
supabase/
├── functions/
│   ├── playbook-export/            # NOUVEAU — Edge Function GET, génère le CSV
│   │   └── index.ts
│   ├── playbook-templates-crud/    # NOUVEAU — Edge Function REST CRUD templates de message
│   │   └── index.ts
│   └── _shared/
│       ├── playbook-engine.ts      # EXISTANT — réutilisé (VALID_TEMPLATE_CATEGORIES, eligibility_criteria)
│       └── merge-tags.ts           # NOUVEAU — résolution pure des merge-tags + génération CSV RFC 4180
├── migrations/
│   └── <timestamp>_playbook_message_templates.sql   # NOUVEAU — table + RLS + index unique partiel
└── tests/
    ├── playbook-export.test.ts         # NOUVEAU
    ├── playbook-templates-crud.test.ts # NOUVEAU
    └── merge-tags.test.ts              # NOUVEAU — tests purs (résolution, échappement CSV, Zero-PII)

docs/
└── merge-tags-mapping.md   # NOUVEAU — livrable documentaire volet 3 (PAS du code, PAS de tâche d'implémentation applicative)
```

**Structure Decision**: Extension du monorepo existant (`/supabase/functions`, `/supabase/migrations`, `/supabase/tests`), aucune nouvelle app ni service séparé. Le nom exact des Edge Functions (`playbook-export`, `playbook-templates-crud`) et leur découpage (fonction dédiée vs extension de `playbook-crud` existant) restent à confirmer lors de `/speckit-tasks`, sans impact sur ce plan.

**Note explicite sur le volet 3** : `docs/merge-tags-mapping.md` est un livrable purement documentaire. Il ne doit générer aucune tâche de développement (pas d'API ESP, pas d'UI) dans `/speckit-tasks` — uniquement une tâche de rédaction/revue de contenu.

## Complexity Tracking

Aucune violation constitutionnelle — section non applicable.
