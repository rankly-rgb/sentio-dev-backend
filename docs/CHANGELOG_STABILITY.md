# Changelog Stabilité — Sentio AI SaaS FR

Historique complet des audits de stabilité et corrections. Extrait du CLAUDE.md le 2026-03-05.

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

## Export Playbook Intelligent v1 (2026-03-07)

Backend complet pour l'export intelligent de comptes par playbook en CSV/JSON.

**Migration `20260307000001_create_playbook_exports.sql` :**
- Table `playbook_exports` : organisation_id, playbook_id, format, account_count, mrr_at_risk_cents, filters_applied
- RLS `org_isolation` standard
- Index idempotence : unique sur `(org_id, playbook_id, format, filters, minute)` — empêche les doublons d'export
- Trigger `update_updated_at_column()`

**RPC `20260307000002_playbook_export_rpc.sql` :**
- `get_playbook_export_summary(p_playbook_id, p_filters)` — SECURITY DEFINER
- Verification explicite organization_id (cross-tenant prevention)
- Retourne : total_accounts, total_mrr_at_risk_cents, by_priority (P0/P1/P2), by_segment

**Edge Function `export-playbook-accounts` :**
- Pipeline : CORS → Auth (ES256) → Tenant → Query accounts → Join HubSpot/invoices/usage/segments → Compute priority/trigger_reason/hubspot_import_note → Sort (P0 > P1 > P2, MRR desc) → Log export → Slack fire-and-forget → CSV ou JSON
- Priority : P0 = churn_risk >= 70 ET days_to_renewal < 30, P1 = churn_risk >= 50 OU days_to_renewal < 60, P2 = defaut
- Filtres : priority, segment, churn_risk_min, mrr_min_cents, billing_interval
- CSV : 18 colonnes incluant trigger_reason et hubspot_import_note pre-redigee en français
- Zero-PII : uniquement stripe_customer_id et hubspot_company_id
- Montants en centimes en base, convertis en euros dans le CSV uniquement

**Shared helpers `_shared/export-helpers.ts` :**
- Fonctions pures extraites pour testabilite (pas d'imports Deno/jsr)
- `computePriority`, `computeDaysToRenewal`, `buildTriggerReason`, `buildHubspotImportNote`, `sortAccounts`, `buildCsv`, `formatActionType`

**Tests : 39 nouveaux tests (283 total) :**
- Priority : 3 cas limites (P0/P1/P2) + valeurs nulles + boundaries exactes
- trigger_reason : 1, 2 et 3 signaux actifs + signaux inactifs
- Sort : P0 > P1 > P2, MRR decroissant intra-priorite
- CSV : colonnes, null handling, escaping virgules/guillemets, count = JSON count
- Filtres : churn_risk_min, mrr_min_cents

---

## Segment Detail Backend v1 (2026-03-07)

Backend complet pour l'ecran de detail de segment : RPC paginee + export CSV.

**Migration `20260307000003_segment_detail_rpc.sql` :**
- RPC `get_segment_accounts(p_segment, p_sort_by, p_sort_order, p_limit, p_offset)`
- SECURITY DEFINER avec `SET search_path = public`
- Utilise `segment_memberships` + `account_segments` (source de verite, pas de criteres inline)
- Validation segment/sort_by/sort_order dans la fonction, cap p_limit a 10000
- Cross-tenant : triple verification organization_id (accounts, segment_memberships, account_segments)
- GRANT EXECUTE to authenticated

---

## Export Segment CSV v2 (2026-03-07)

Refactoring de `export-segment-csv` pour aligner le backend sur les filtres du frontend.

**Probleme** : l'ancien export utilisait une RPC `get_segment_accounts` basee sur `segment_memberships`, tandis que le frontend utilise des filtres in-memory sur les scores. Resultat : le CSV exporte pouvait contenir des comptes differents de ceux affiches a l'ecran.

**Solution** : query directe `accounts` + filtrage in-memory identique au frontend.

**Edge Function `export-segment-csv` (reecrite) :**
- GET `/functions/v1/export-segment-csv?segment=champions`
- Pipeline : CORS -> Auth (ES256) -> Validate segment -> Service Client -> Query accounts (org_id, ORDER BY mrr_cents DESC) -> Filter in-memory (SEGMENT_FILTERS) -> CSV avec BOM -> Response
- Suppression des params `sort_by`/`sort_order` (tri fixe mrr_cents DESC)
- Pas de LIMIT : export complet de tous les comptes du segment
- BOM UTF-8 (`\uFEFF`) pour compatibilite Excel FR
- Messages d'erreur en francais
- Filename : `segment-<SEGMENT>.csv`
- 12 colonnes CSV (inchangees) : stripe_customer_id, hubspot_company_id, plan_tier, billing_interval, mrr_eur, seat_count, seat_limit, contract_end_date, health_score, churn_risk_score, expansion_score, product_usage_score

**Shared helpers `_shared/segment-export-helpers.ts` :**
- `SEGMENT_FILTERS` : 8 filtres purs, mirroir exact de `segment-queries.ts` (frontend)
- `created_at` ajoute a `SegmentAccountRow` (necessaire pour filtre `nouveaux` < 90 jours)
- `buildSegmentCsv()` : BOM UTF-8 en prefixe, plus de commentaire Zero-PII en ligne

**Filtres de segment (SEGMENT_FILTERS) :**

| Segment | Critere |
|---------|---------|
| `champions` | health > 80 ET expansion > 70 |
| `en_expansion` | expansion > 75 |
| `stables` | health 60-80 ET churn_risk < 30 |
| `a_risque_leger` | health 40-59 OU churn_risk 30-50 |
| `en_danger_critique` | health < 40 OU churn_risk > 70 |
| `impayes` | churn_risk > 80 ET health < 50 |
| `en_churn` | churn_risk > 90 |
| `nouveaux` | created_at < 90 jours |

**Tests : 49 tests (332 total) :**
- BOM UTF-8 : presence + header apres BOM
- 8 filtres de segment : boundaries exactes, null handling
- CSV : colonnes, null, escaping, empty export
- Validators : segments, sort fields, sort orders

---

## Webhook Universel Sortant v1 (2026-03-07)

Systeme de webhook sortant universel permettant a Sentio AI de declencher des actions dans n'importe quel outil tiers (Brevo, Klaviyo, Salesforce, backend custom) sans integration specifique. Zero-PII garanti : seul le `stripe_customer_id` (identifiant technique anonyme) est transmis. Le mapping vers l'email est fait cote client via l'integration Stripe native de leur outil.

**Migration `20260307000004_webhook_outbound.sql` :**
- Extension `webhook_configs` : `active_events` (JSONB), `last_triggered_at`, `failure_count`
- Provider CHECK elargi : `stripe`, `hubspot`, `usage`, `webhook`
- Extension `webhook_dead_letter` : provider CHECK ajoute `outbound_webhook`
- RPC `increment_webhook_failure(p_org_id)` : incrementation atomique + RETURNING

**Shared helpers `_shared/webhook-helpers.ts` (pures, testables Vitest) :**
- `buildPayload()` : construit le payload standardise (event, account, signals, metadata)
- `isEventActive()` : verifie si un evenement est dans la liste active_events
- `shouldDisableWebhook()` : true si failure_count >= 5
- `computeHmacSignature()` : HMAC-SHA256 via crypto.subtle
- `mapPlaybookToEvent()` : mappe trigger_conditions d'un playbook vers un WebhookEvent
- `containsPII()` : detection recursive de champs PII dans un objet

**Shared module `_shared/webhook-dispatcher.ts` (orchestrateur Deno) :**
- Re-exporte les fonctions pures de webhook-helpers.ts
- `dispatchWebhook()` : query config → filtre event → build payload → signe HMAC → envoie avec retry(3x) + circuit breaker(5 fails/60s reset) + timeout(10s)
- Succes : reset failure_count, update last_triggered_at
- Echec : increment failure_count (RPC atomique), DLQ write, auto-disable a 5 echecs + alerte Slack
- Ne throw jamais (fire-and-forget pour ne pas bloquer le flux principal)

**Edge Function `webhook-config` (single function, sub-path routing) :**

| Route | Methode | Role |
|-------|---------|------|
| `/webhook-config` | GET | Config actuelle (secret masque) |
| `/webhook-config` | POST | Creer ou mettre a jour (endpoint_url, active_events) |
| `/webhook-config/test` | POST | Envoie payload test `cus_TEST_sentio_demo`, retourne status_code + latency_ms |
| `/webhook-config/regenerate-secret` | POST | Genere nouveau secret HMAC, retourne en clair une fois, log audit |
| `/webhook-config/disable` | POST | Desactive le webhook (soft delete) |

**Payload standardise :**
```json
{
  "event": "churn_risk_critical",
  "triggered_at": "2026-03-07T...",
  "organization_id": "uuid",
  "account": {
    "account_id": "uuid",
    "stripe_customer_id": "cus_xxx",
    "hubspot_company_id": "hs_xxx"
  },
  "signals": {
    "health_score": 28,
    "churn_risk_score": 84,
    "expansion_score": 12,
    "mrr_cents": 49900,
    "trigger_reason": "churn_risk > 70"
  },
  "metadata": { "playbook_id": "..." }
}
```

**Headers HTTP sortants :**
- `X-Sentio-Event` : type d'evenement
- `X-Sentio-Signature` : HMAC-SHA256 hex
- `X-Sentio-Timestamp` : unix timestamp
- `X-Sentio-Version` : `1`

**6 evenements supportes :**
`churn_risk_critical`, `payment_failed`, `renewal_reminder`, `expansion_opportunity`, `health_score_drop`, `onboarding_completed`

**Integrations dans les Edge Functions existantes :**
- `playbook-execute` : dispatch webhook apres chaque execution reussie (event mappe via `mapPlaybookToEvent`)
- `stripe-webhook` : dispatch `payment_failed` sur `invoice.payment_failed`
- `calculate-scores` : dispatch `churn_risk_critical` quand un compte franchit le seuil 70

**Tests : 31 nouveaux tests (363 total) :**
- Payload : champs requis, hubspot optionnel, metadata, stripe_customer_id toujours present
- Zero-PII : pas d'email/nom/phone dans le payload, detection PII recursive
- isEventActive : filtre actif/inactif, liste vide
- shouldDisableWebhook : boundaries 4/5
- HMAC : format hex 64 chars, deterministe, different par payload/secret
- mapPlaybookToEvent : churn_risk, health_score, expansion, null, vide, non-reconnu

---

## OAuth Multi-tenant + Completions v1 (2026-03-08)

Audit du prompt "OAuth Multi-tenant + Webhook Universel Sortant" : 3 ecarts corriges + documentation.

**Migration `20260308000003_cron_refresh_hubspot_tokens.sql` :**
- Cron `refresh-hubspot-tokens` : `0 */5 * * *` (toutes les 5h, avant expiration 6h HubSpot)
- Cron `cleanup-expired-oauth-states` : `0 * * * *` (nettoyage horaire des states CSRF expires)

**stripe-webhook : `customer.subscription.trial_will_end` :**
- Ajout dans `ROUTED_EVENTS`
- Handler via `handleSubscriptionEvent` existant
- Dispatch webhook `renewal_reminder` avec date de fin de trial dans `trigger_reason`
- Permet aux clients de declencher des actions (email Brevo, task CRM) avant expiration du trial

**Tests : 29 nouveaux tests (425 total) :**
- `oauth-integration.test.ts` : 8 suites couvrant les scenarios requis par le prompt
- OAuth state TTL 10 min : 5 tests (validite, expiration, boundary)
- OAuth state single-use : 2 tests (Map-based simulation, expiry check)
- Tenant resolution null sans fallback : 3 tests (Connect, customer, chain complete)
- Revocation ordre operations : 2 tests (provider API > Vault > DB, echec partiel)
- Refresh token failure Slack : 3 tests (status expired, isTokenExpiringSoon, message format)
- Webhook payload Zero-PII : 4 tests (clean, email inject, nested PII, stripe_customer_id ok)
- Webhook HMAC depuis Vault : 4 tests (signature, differentes cles, determinisme, priorite Vault)
- Circuit breaker 5 echecs : 6 tests (boundaries, escalation flow, reset)

---

## Backlog

- Propager `contract_end_date` dans `stripe-webhook`
- NPS : collecte + intégration scoring (V2)
