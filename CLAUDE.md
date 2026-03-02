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

### Tests (63 passing)

- `supabase/tests/scoring.test.ts` : 48 tests (7 fonctions de scoring + 12 tests segmentation)
- `supabase/tests/utilities.test.ts` : 15 tests (circuit breaker, retry, logger)

### Ops

- `docs/RUNBOOK.md` : 6 procédures d'incident + seuils d'alerte
- CI gating : `deploy-vercel.yml` attend succès CI avant deploy

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
