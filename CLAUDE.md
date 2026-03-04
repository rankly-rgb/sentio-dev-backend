# CLAUDE.md — Sentio AI SaaS FR

Ce fichier fournit les instructions à Claude Code pour travailler sur ce repo.

## Source de vérité (obligatoire)

Claude Code doit traiter ces documents comme faisant autorité :
- Spécification produit : `docs/openspec.md`
- Règles de validation : `docs/test-spec/*`
- Instructions Claude : `CLAUDE.md`
- Document de fondation : `docs/SENTIO_AI_SaaS_FR_Projet_Foundation.md`

En cas de conflit :
1) `docs/openspec.md` prime sur tout
2) Les test specs définissent le comportement attendu
3) L'implémentation s'adapte

## Vue d'ensemble

Sentio AI SaaS FR est une plateforme de Customer Intelligence pour éditeurs SaaS B2B francophones. Elle ingère les données Stripe (facturation), HubSpot (engagement commercial) et usage produit pour calculer des scores de santé client, détecter les risques de churn et identifier les opportunités d'expansion.

**Architecture Zero-PII** : la plateforme ne stocke jamais d'email, nom, téléphone, adresse IP ou données personnelles. Uniquement des identifiants anonymes et des métriques comportementales agrégées.

## Stack technique

| Couche | Technologie |
|--------|-------------|
| Base de données | Supabase PostgreSQL + RLS |
| Backend | Supabase Edge Functions (Deno) |
| Frontend | Next.js 14 App Router |
| Langage | TypeScript 5.x (target ES5 — pas de `[...new Set()]`) |
| Styling | Tailwind CSS 3.x |
| Auth | @supabase/ssr (cookies, PKCE) |
| Tests | Vitest |
| CI/CD | GitHub Actions + Vercel |
| Intégrations | Stripe, HubSpot |

## Phase actuelle

Le projet est en **phase de setup et développement**.
Le déploiement production est **intentionnellement inactif**.
Claude ne doit pas supposer une production-readiness sauf instruction explicite.

## Tables principales

| Table | Rôle |
|-------|------|
| `organizations` | Config multi-tenant, credentials API |
| `accounts` | Comptes clients SaaS (remplace `customers`) |
| `subscriptions` | Abonnements Stripe par account |
| `invoices` | Factures Stripe |
| `mrr_movements` | Log des mouvements MRR (new/expansion/contraction/churn/reactivation) |
| `usage_events` | Événements d'usage produit |
| `hubspot_companies` | Données HubSpot par account |
| `score_history` | Snapshots quotidiens des scores |
| `customer_segments` | Définitions de segments |
| `segment_memberships` | Assignations account→segment |
| `ai_insights` | Insights IA générés |
| `playbooks` | Définitions de playbooks rétention |
| `playbook_executions` | Journal d'exécution |
| `data_syncs` | Journal des synchronisations |
| `webhook_configs` | Credentials HMAC par org/provider |
| `webhook_dead_letter` | DLQ webhooks échoués |
| `cron_locks` | Verrouillage distribué cron |

## Moteur de scoring SaaS

```
Health Score = (Usage × 35%) + (Financial × 25%) + (Engagement × 20%) + (Contract × 20%)
Churn Risk = 100 - Health Score + facteurs de risque additifs (capped 100)
Expansion Score = (seat_usage_pct × 60%) + (feature_ceiling × 40%)
```

**Valeurs neutres (pas de données = 50)** : Usage, Engagement, Contrat retournent 50 quand aucune donnée n'est disponible. Financial retourne 0 (pas de MRR = pas de revenus).

**Engagement V1** : basé sur tickets support (±25 pts) + dernière réunion (±25 pts). NPS retiré du V1 (prévu V2).

## Segments SaaS B2B

Champions, En expansion, Stables, À risque léger, En danger critique, Impayés, En churn, Nouveaux (< 90j).

## Intégrations

- **Stripe** : source de vérité financière (webhooks + sync quotidien)
- **HubSpot** : engagement commercial (sync quotidien companies/deals/tickets)
- **Usage produit** : endpoint webhook direct `POST /functions/v1/track-usage`

## Edge Function Pattern (Deno)

Pour toute nouvelle Edge Function :
1. CORS check (`handleCors`)
2. Auth / vérification HMAC
3. `createServiceClient()` dans try/catch
4. Parse + validation payload
5. Résolution du tenant (organization_id)
6. Logique métier
7. Persistance
8. Réponse rapide (< 5s pour webhooks)

Pour les fonctions **cron** (sync-stripe, calculate-scores) :
1. `acquireCronLock()` → 409 si déjà en cours
2. try: logique métier + `DataSyncLogger`
3. catch: `logger.fail()` + `alertSlack()`
4. finally: `releaseCronLock()`

Pour les **webhooks** (stripe-webhook) :
1. catch: `writeToDLQ()` + `alertSlack()` + toujours HTTP 200

Appels API externes (Stripe) :
- Toujours via `fetchWithTimeout(8s)` + `retryWithBackoff(3x)` + `CircuitBreaker`

## Multi-Tenant & RLS (non-négociable)

- Chaque query scopée par `organization_id`
- RLS = couche de sécurité primaire
- Toute nouvelle table DOIT avoir `organization_id`
- Helpers : `user_organization_id()`, `user_role()`

## Zero-PII (non-négociable)

Ne jamais stocker : email, nom, téléphone, adresse, IP, SIRET lié à une personne.
Identifiants autorisés : `stripe_customer_id`, `hubspot_company_id` (anonymes).

## Commandes

```bash
npm run dev          # Serveur Next.js local
npm run build        # Build production
npm run test         # Tests Vitest
npm run lint         # ESLint
```

## Variables d'environnement

| Variable | Obligatoire | Usage |
|----------|-------------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Oui | Client-side Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Oui | Client-side Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Oui | Server-side / Edge Functions |
| `STRIPE_SECRET_KEY` | Oui | API Stripe |
| `STRIPE_WEBHOOK_SECRET` | Oui | Validation HMAC webhooks Stripe |
| `HUBSPOT_API_KEY` | Non | API HubSpot |
| `SLACK_WEBHOOK_URL` | Non | Alertes monitoring |

## Contraintes Claude Code

Claude Code DOIT :
- Aligner avec `docs/openspec.md` et `docs/SENTIO_AI_SaaS_FR_Projet_Foundation.md`
- Respecter la phase actuelle (setup/dev uniquement)
- Utiliser Context7 pour toute génération de code dépendant d'une librairie
- Consulter l'inventaire de réutilisabilité (section 6 du Foundation doc) avant de créer un fichier

Claude Code NE DOIT PAS :
- Modifier les fondations multi-tenant sans approbation explicite
- Introduire de PII ou affaiblir les garanties Zero-PII
- Modifier les formules de scoring sans instruction explicite
- Ajouter d'infrastructure ou framework sans justification

## Working Pattern (obligatoire)

Pour chaque tâche :
1. Reformuler l'objectif en 1-2 lignes
2. Identifier les zones impactées
3. Si l'archi/specs changent, mettre à jour /docs d'abord
4. Proposer un plan minimal (3-7 étapes)
5. Implémenter en petits commits
6. Fournir une checklist de vérification

## Anti-surengineering

- Solution la plus simple pour le V1
- Pas d'abstraction sauf si réutilisée 2+ fois
- Pas de package sans justification
- Code explicite > patterns cleveres

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

### Edge Functions opérationnelles

| Fonction | Trigger | Rôle |
|----------|---------|------|
| `health-check` | GET (monitoring externe, chaque 5 min) | DB, locks, syncs, DLQ |
| `self-monitor` | POST (cron Supabase, chaque 15 min) | Auto-recovery + alertes Slack |

### Bug fixes appliqués

- `calculate-scores` : mutation builder `orgQuery` (filtre org_id silencieusement ignoré)
- `sync-stripe` + `stripe-webhook` : détection intervalle annuel (`price.recurring.interval`)
- `sync-stripe` : agrégation MRR multi-abonnement par compte
- `supabase-client.ts` : headers CORS sur `jsonResponse`/`errorResponse`
- `track-usage` : suppression overhead DataSyncLogger par événement

### Scoring & Segmentation v1 (2026-03-03)

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
- Met à jour `account_segments` (count, MRR, avg scores) et `segment_memberships`

**Règles de segmentation (priorité décroissante, mutuellement exclusif sauf `nouveaux`) :**
1. `nouveaux` — créé < 90 jours (non-exclusif, se cumule avec un segment score-based)
2. `en_churn` — MRR = 0
3. `impayes` — factures impayées
4. `en_danger_critique` — churn_risk >= 70
5. `a_risque_leger` — churn_risk >= 50
6. `champions` — health >= 80
7. `en_expansion` — expansion >= 70 ET health >= 60
8. `stables` — défaut

### Migrations

- `20260302000001_stability_indexes.sql` : 10 index de performance (DLQ, cron_locks, data_syncs, usage_events, invoices, hubspot_companies, score_history)
- `20260303000001_scoring_segmentation_fixes.sql` : contrainte CHECK élargie, source `scoring` dans data_syncs, seed des 8 segments système, index unique partiel `(org_id, segment_type) WHERE is_system_generated`

### Tests (190 passing)

- `supabase/tests/scoring.test.ts` : 49 tests (7 fonctions de scoring + 12 tests segmentation)
- `supabase/tests/utilities.test.ts` : 15 tests (circuit breaker, retry, logger)
- `supabase/tests/playbook-engine.test.ts` : 61 tests (types, validation, conditions, actions)
- `supabase/tests/admin-proxy.test.ts` : 24 tests (auth, routing, validation)

### Playbooks Backend v1 (2026-03-03)

Implémentation complète du backend playbooks : moteur, CRUD, exécution, scheduler.

**Edge Functions :**

| Fonction | Trigger | Rôle |
|----------|---------|------|
| `playbook-crud` | REST (JWT) | CRUD playbooks (POST/GET/PUT/DELETE) avec validation, pagination, soft delete |
| `playbook-execute` | POST (JWT) | Exécute un playbook sur des comptes spécifiques ou un segment |
| `playbook-scheduler` | POST (cron) | Exécution automatique des playbooks planifiés (is_automated=true) |

**Shared Utility :**

| Module | Rôle |
|--------|------|
| `playbook-engine.ts` | Types, validation JSONB, évaluation de conditions, exécution d'actions (pure) |
| `auth.ts` | Vérification JWT ES256 via supabase.auth.getUser() + résolution organization_id |

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

**API playbook-crud :**
- `POST /functions/v1/playbook-crud` — Créer (status=draft forcé)
- `GET /functions/v1/playbook-crud?organization_id=X` — Lister (filtres: status, segment_id, playbook_type, template_category, is_template, page, per_page)
- `GET /functions/v1/playbook-crud?id=X` — Détail + execution_stats
- `PUT /functions/v1/playbook-crud?id=X` — Modifier (transitions de statut gérées)
- `DELETE /functions/v1/playbook-crud?id=X` — Archiver (soft delete)

**API playbook-execute :**
- `POST /functions/v1/playbook-execute` — Body: `{ playbook_id, organization_id, account_ids | segment_id, execution_source?, cooldown_hours? }`

**V1 : actions loggées mais pas dispatchées** (pas d'appel API externe). Max 200 comptes par run. Idempotence 24h.

**Auth ES256 :**
- Supabase Auth utilise ES256 (ECDSA) pour les JWT utilisateurs
- `verify_jwt = true` dans config.toml ne valide que HS256 → rejet des JWT utilisateurs
- Fix : `_shared/auth.ts` vérifie le JWT via `supabase.auth.getUser()` (compatible ES256)
- `playbook-crud` et `playbook-execute` : `verify_jwt = false` + auth dans le code
- `playbook-scheduler` : `verify_jwt = true` (cron utilise service_role HS256)

**Templates playbook :**
- 6 templates système (is_template=true) : churn_prevention, reactivation, expansion, onboarding, renewal, winback
- Script de seed : `scripts/seed-playbook-templates.ts` (`npx tsx scripts/seed-playbook-templates.ts <org_id>`)
- API : `GET /playbook-crud?organization_id=X&is_template=true` pour lister les templates

**Tests : 61 tests** dans `supabase/tests/playbook-engine.test.ts` (124 total).

### Stability Audit v2 (2026-03-04)

Audit complet de stabilité sur toutes les couches (71 issues identifiées, 6 phases implémentées).

**Phase 1 — Sécurité (3 failles cross-tenant critiques) :**
- `auth.ts` : rejet des `organization_id` null (bypass authorization)
- `playbook-crud` : toutes les opérations CRUD scopées par `auth.organizationId` (plus de lecture/écriture cross-tenant)
- `track-usage` : réassignation explicite du query builder (filtre `organization_id` silencieusement ignoré)
- `auth/callback` : validation du chemin de redirection (prévention open redirect)
- `server.js` : supprimé (serveur Express orphelin avec handler non-authentifié)
- `next.config.js` : ajout Content-Security-Policy header

**Phase 2 — Fiabilité Edge Functions (élimination N+1 queries, crash prevention) :**
- `calculate-scores` : batching par 500 comptes + 3 queries parallèles bulk (remplace ~1500 queries séquentielles)
- `calculate-scores` : `scoreAccountPure()` — fonction pure sans appels DB
- `sync-stripe` : pré-construction de Maps (`customerToAccount`, `invoiceCustomerMap`) avant boucles de pagination
- `stripe-webhook` : comparaison MRR par subscription (plus par agrégat compte)
- `cron-lock.ts` : distinction erreur de contention (attendue) vs erreur DB (inattendue)
- `data-sync-logger.ts` : `fail()` wrappé en try/catch
- `playbook-execute` : try/catch autour de la boucle d'exécution, mark 'failed' sur crash
- `playbook-scheduler` : error check sur `updateNextSchedule`
- `calculate-scores` : `assignSegments()` atomique (upsert + cleanup au lieu de delete + insert)
- `playbook-crud` : `.limit(500)` sur les requêtes d'exécutions dans handleGetOne

**Phase 3 — Frontend Stability :**
- `src/middleware.ts` : refresh session Supabase sur chaque requête (sessions longues actives)
- Error boundaries : `src/app/error.tsx`, `src/app/global-error.tsx`, `src/app/dashboard/error.tsx`
- `src/app/dashboard/loading.tsx` : skeleton UI pendant le chargement
- `src/lib/env.ts` : validation des variables d'environnement (remplace assertions `!`)
- `src/app/api/sync-stripe/route.ts` : `maxDuration=60` + AbortController 55s timeout
- `src/app/api/health/route.ts` : endpoint health check (env + connectivité DB)
- `src/app/dashboard/page.tsx` : `.limit(10000)` + count exact pour prévenir OOM

**Phase 4 — Database Hardening :**
- Migration `20260304000001_stability_phase2_fixes.sql` : CHECK constraint sur `data_syncs.error_type`, unique constraint `segment_memberships`
- Migration `20260304000002_stability_phase3_4.sql` : ON DELETE CASCADE sur `profiles_.organization_id` FK, CHECK constraints `playbooks.status` + `playbook_executions.execution_status`, index stuck executions

**Phase 5 — CI/CD :**
- `ci.yml` : ajout `npm audit --audit-level=high` step
- `deploy-vercel.yml` : workflow de deploy gaté sur succès CI
- `supabase/config.toml` : enregistrement `health-check` + `self-monitor`
- `package.json` : `stripe` déplacé de devDependencies vers dependencies

**Phase 6 — Monitoring :**
- `self-monitor` : check #5 — auto-fail des `playbook_executions` bloquées en 'running' > 15 min

### Stability Audit v3 (2026-03-04)

Renforcement post-audit v2 : 16 fichiers modifiés, 189 tests passing.

**Data Integrity :**
- `stripe-webhook` : fix TOCTOU — lecture `prevSubMrr` AVANT l'upsert subscription (corrige expansion/contraction MRR jamais détectées)
- `stripe-webhook` : idempotency check via `event.id` dans `data_syncs` (prévention traitement en double)
- `stripe-webhook` : `.maybeSingle()` sur `resolveOrganization` (prévention crash si aucun résultat)

**Sécurité :**
- `next.config.js` : suppression `unsafe-eval` du CSP, ajout `Permissions-Policy`, `poweredByHeader: false`
- `dashboard/error.tsx` : affichage `error.digest` au lieu de `error.message` brut (prévention fuite d'info)
- `global-error.tsx` : ajout `useEffect` logging avec digest
- `auth/callback` : `decodeURIComponent` pour prévenir bypass open redirect encodé
- `middleware.ts` : try/catch sur `auth.getUser()` avec 503 si auth service down

**Frontend Resilience :**
- `login/page.tsx` : support `?next=` redirect param avec protection open redirect + Suspense boundary pour `useSearchParams()`
- `dashboard/page.tsx` : Suspense boundary autour de `SyncStatus`, `.maybeSingle()` pour profiles
- `client.ts` : pattern singleton pour prévenir instances multiples de Supabase
- `middleware.ts` : `?? ''` fallback au lieu d'assertions `!` sur env vars

**Infrastructure :**
- `self-monitor` : ajout `acquireCronLock`/`releaseCronLock` (prévention exécutions concurrentes)
- `self-monitor` : `.maybeSingle()` sur score_history (prévention crash si vide)
- `calculate-scores` : `MAX_BATCHES=200` guard + `.limit(50000)` sur usage_events
- `playbook-scheduler` : `.limit(50)` sur requête playbooks planifiés
- `playbook-execute` : enforcement `auth.organizationId` (prévention cross-tenant)
- `sync-stripe/route.ts` : `.maybeSingle()` pour profiles query

**CI/CD :**
- `ci.yml` : suppression `|| true` sur `npm audit` (audit bloquant), lint avant tests
- `server.ts` : correction commentaire eslint-disable

### Stability Audit v4 (2026-03-04)

Renforcement post-audit v3 : 10 fichiers modifiés, 190 tests passing.

**Batch A — Data Integrity :**
- `stripe-webhook` : tous les `.single()` restants → `.maybeSingle()` (handleSubscriptionEvent account lookup, handleInvoiceEvent account + subscription lookups, entrypoint fallback queries)
- `sync-stripe` : lastSync query `.single()` → `.maybeSingle()`, validation timestamp avant arithmétique (guard dates futures/invalides)
- `calculate-scores` : maxMrrRow `.single()` → `.maybeSingle()`, `?? 1` → `|| 1` pour maxMrrCents (gère cas 0)

**Batch B — Crash Prevention :**
- `auth.ts` : try/catch séparés sur `createClient` (500) et `getUser` (503 si service down), profiles query `.maybeSingle()`
- `playbook-scheduler` : `releaseCronLock` wrappé try/catch dans finally (prévention lock permanent si DB error)
- `self-monitor` : même safety wrapper `releaseCronLock`

**Batch C — Frontend Resilience :**
- `RefreshDataButton` : AbortController + 65s timeout, try/catch sur `resp.json()`, auto-clear résultat 5s via useEffect, distinction erreur abort, aria-label, focus ring
- `SyncStatus` : try/catch avec fallback UI (graceful degradation)
- `sync-stripe/route.ts` : rate limit 60s par org (query `data_syncs` avant appel Edge Function), réponse 429

**Batch D — Housekeeping :**
- `self-monitor` : check #6 — nettoyage DLQ > 30 jours (batch delete `.limit(500)`)
- `workflow-executor` : `console.warn` sur champs template manquants (observabilité interpolation)

### Ops

- `docs/RUNBOOK.md` : 6 procédures d'incident + seuils d'alerte
- CI gating : `deploy-vercel.yml` attend succès CI avant deploy

### Scoring Audit V1 (2026-03-04)

Audit du pipeline de scoring santé lors de l'ouverture d'un compte client.

**Problèmes identifiés :**
- Sous-scores `financial_score`, `engagement_score`, `contract_score` calculés mais non persistés (seul `product_usage_score` est stocké)
- `calcUsageScore` retournait 0 quand pas de données (punitif), contrairement à engagement/contrat (50, neutre)
- `calcEngagementScore` dépendait de `nps_score` — donnée indisponible en V1 (pas de collecte NPS)
- Pas de fonction `sync-hubspot` — table `hubspot_companies` toujours vide
- `stripe-webhook` ne propage pas `contract_end_date` vers `accounts` (seulement `sync-stripe` le fait)

**Corrections appliquées :**
- `calcUsageScore` : retourne 50 (neutre) quand `total_events = 0`, cohérent avec engagement et contrat
- `calcEngagementScore` : NPS supprimé du V1 (roadmap V2), poids redistribué sur tickets (±25 pts) et meetings (±25 pts)
- Tests mis à jour (190 passing)

**Valeurs neutres par sous-score (pas de données) :**

| Sous-score | Valeur neutre | Raison |
|-----------|--------------|--------|
| Usage | 50 | Pas de tracking produit = neutre |
| Financial | 0 | Pas de MRR = pas de revenus |
| Engagement | 50 | Pas de HubSpot = neutre |
| Contrat | 50 | Pas de date contrat = neutre |

**Engagement V1 (sans NPS) :**

| Signal | Pts |
|--------|-----|
| 0 tickets | +15 |
| 1-2 tickets | -5 |
| 3+ tickets | -25 |
| Meeting < 30j | +25 |
| Meeting 30-60j | +10 |
| Meeting > 90j | -15 |
| Meeting > 180j | -25 |

**Reste à faire (backlog) :**
- Créer `sync-hubspot` Edge Function
- Propager `contract_end_date` dans `stripe-webhook`
- NPS : collecte + intégration scoring (V2)

### Scoring Sub-Scores Persistence (2026-03-05)

Complétion de la décomposition du score de santé : les 3 sous-scores manquants sont désormais persistés.

**Cause racine :**
- `financial_score`, `engagement_score`, `contract_score` étaient calculés dans `scoreAccountPure()` mais jetés — seul `product_usage_score` était retourné et stocké
- Les colonnes n'existaient pas dans les tables `accounts` et `score_history`

**Corrections appliquées :**
- Migration `20260305000002_add_subscores_columns.sql` : ajout `financial_score`, `engagement_score`, `contract_score` (NUMERIC 5,2, nullable, CHECK 0-100) aux tables `accounts` et `score_history`
- `calculate-scores/index.ts` : `ScoreResult` étendu avec les 3 champs
- `calculate-scores/index.ts` : `scoreAccountPure()` retourne les 3 sous-scores
- `calculate-scores/index.ts` : upsert `score_history` + update `accounts` incluent les 3 sous-scores

**Sous-scores persistés (complet) :**

| Colonne | Table `accounts` | Table `score_history` | Statut |
|---------|-----------------|----------------------|--------|
| `product_usage_score` | Oui | Oui | Existait |
| `financial_score` | Oui | Oui | **Ajouté** |
| `engagement_score` | Oui | Oui | **Ajouté** |
| `contract_score` | Oui | Oui | **Ajouté** |

Tests : 190 passing (aucune régression).

**HubSpot API :**
- Token `pat-eu` (Private App Token EU) fonctionnel via `api.hubapi.com`
- 50 companies disponibles, données d'engagement très pauvres (pas de NPS, pas de tickets, 1 seule avec meetings)
- Propriétés exploitables : `hs_num_open_deals`, `hs_last_booked_meeting_date`, `hs_last_logged_outgoing_email_date`, `lifecyclestage`

### AI Insights Backend v1 (2026-03-05)

Implémentation complète du moteur de génération d'insights IA + API CRUD.

**Edge Functions :**

| Fonction | Trigger | Rôle |
|----------|---------|------|
| `generate-insights` | POST (cron) | Génère quotidiennement les insights basés sur les scores |
| `insights-crud` | REST (JWT) | API CRUD insights (GET list/detail/stats, PATCH statut) |

**Shared Utility :**

| Module | Rôle |
|--------|------|
| `insight-rules.ts` | Règles de génération pures (5 types d'insights, 100% testable) |

**5 types d'insights (rules-v1) :**

| Type | Condition | Priority |
|------|-----------|----------|
| `churn_prediction` | churn_risk >= 70 | critical (>=85), high |
| `expansion_opportunity` | expansion >= 70 AND health >= 60 | high (>=85), medium |
| `renewal_alert` | contract_end_date < 60j | critical (<30j), high |
| `payment_risk` | overdue > 15j | critical (>30j), high |
| `usage_drop` | usage drop > 30% sur 14j | high (>50%), medium |

**Déduplication :** Index unique partiel `(org_id, account_id, insight_type) WHERE status = 'active'` — 1 seul insight actif par type par account.

**Auto-résolution :** Si la condition a disparu (ex: churn_risk redescendu < 50), l'insight est auto-résolu (status='resolved').

**API insights-crud :**
- `GET /functions/v1/insights-crud` — Liste paginée (filtres: insight_type, priority, status, account_id, sort, page, per_page)
- `GET /functions/v1/insights-crud?id=X` — Détail
- `GET /functions/v1/insights-crud?stats=true` — Compteurs agrégés (par type/priority/status + total MRR impact)
- `PATCH /functions/v1/insights-crud?id=X` — Transition statut (active→acknowledged→resolved/dismissed)

**Migration :** `20260305000003_insights_improvements.sql` — FK CASCADE, index déduplication, colonne `source_scores` JSONB

**Tests :** ~40 tests dans `supabase/tests/insight-rules.test.ts`

## Layout du repo

- `/src` — code applicatif Next.js
- `/docs` — documentation et specs
- `/supabase/functions` — Edge Functions (Deno)
- `/supabase/functions/_shared` — utilities partagées (logger, retry, CB, DLQ, etc.)
- `/supabase/migrations` — migrations SQL
- `/supabase/tests` — tests Vitest
- `/scripts` — scripts utilitaires
- `/.claude` — config Claude Code
- `/.env.example` — template (commité)
- `/.env.local` — secrets (JAMAIS commité)

## Context7 (obligatoire)

Toujours utiliser Context7 pour récupérer la doc à jour avant de générer du code dépendant d'une librairie. Ne pas deviner les signatures d'API.
