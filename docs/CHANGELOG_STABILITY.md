# Changelog Stabilité — Sentio AI SaaS FR

Historique complet des audits de stabilité et corrections. Extrait du CLAUDE.md le 2026-03-05.

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
