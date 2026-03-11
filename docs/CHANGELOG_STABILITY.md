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

## Stripe API Key Integration v1 (2026-03-09)

Alternative a OAuth Connect pour connecter un compte Stripe. Permet aux entreprises de coller leur cle secrete (sk_live_/sk_test_) sans passer par le flux OAuth Connect (qui necessite ca_xxx et onboarding Stripe).

**Migration `20260309000001_add_integration_method.sql` :**
- Colonne `integration_method` TEXT NOT NULL DEFAULT 'oauth' sur `organization_integrations`
- CHECK constraint : `('oauth', 'api_key')`
- Retro-compatible : toutes les integrations existantes sont 'oauth' par defaut

**Shared helpers `_shared/credential-helpers.ts` (NOUVEAU) :**
- `resolveCredentialSource()` : fonction pure determinant la source de credentials (oauth, api_key, global_fallback)
- Regles : integration active → Vault DOIT contenir le token (pas de fallback silencieux sur cle globale)
- `api_key` : pas de Stripe-Account header (cle directe du compte)
- `oauth` : Stripe-Account header avec provider_account_id (Connect)
- `validateStripeApiKey()` : validation format (sk_live_, sk_test_, rk_live_, rk_test_), rejet pk_, longueur min 30
- `IntegrationRow` : interface unifiee avec `integration_method` optionnel

**Edge Function `integration-oauth` — route POST /stripe/api-key :**
- Pipeline : CORS → Auth (ES256) → Parse body (stripe_api_key) → validateStripeApiKey → Check pas deja connecte → Stripe GET /v1/account (valide la cle) → Vault store → Upsert organization_integrations (integration_method: 'api_key') → Update organizations.stripe_account_id → Trigger sync initial → Response
- Pas de provider_account_id ni Stripe-Account header (cle directe)
- Retourne account_id et account_name du compte Stripe valide

**sync-stripe : support api_key :**
- `getStripeCredentials()` selectionne `integration_method` depuis la DB
- `api_key` → `stripeAccount: null` (pas de header Stripe-Account)
- `oauth` → `stripeAccount: source.providerAccountId` (header Connect)

**sync-hubspot : fix fallback silencieux :**
- Utilise `resolveCredentialSource()` au lieu de fallback silencieux sur cle globale

**vault.ts : logging structure :**
- Erreurs RPC loguees en JSON structure (level, module, message, secret_id, error)
- Warnings quand secret non trouve (ID potentiellement stale)

**Tests : 34 tests credential-helpers (459 total) :**
- OAuth happy path : 3 tests (Stripe, HubSpot, null provider_account_id)
- Global fallback : 2 tests (Stripe, HubSpot)
- Missing vault_access_token_id : 4 tests (Stripe, HubSpot, message, method in error)
- Vault secret stale : 4 tests (Stripe, HubSpot, includes ID, no fallback)
- HubSpot expiration : 4 tests (expired, Stripe skip, not expired, null)
- API key : 6 tests (happy path, null provider, default oauth, undefined, vault missing, no expiry check)
- validateStripeApiKey : 11 tests (sk_live, sk_test, rk_live, rk_test, pk reject, unknown prefix, too short, empty, trim, boundary 30/29)

---

## Auto-Profile on Signup v1 (2026-03-09)

Correction du bug ou les playbooks/workflows etaient invisibles pour les utilisateurs non-admin. Cause racine : aucun profil `profiles_` n'etait cree automatiquement a l'inscription, donc `user_organization_id()` retournait NULL et le RLS bloquait tout.

**Migration `20260309000002_auto_profile_on_signup.sql` :**
- Trigger function `handle_new_user()` SECURITY DEFINER sur `auth.users` AFTER INSERT
- Recherche invitation valide (non expiree, non acceptee) par email
- Cree `profiles_` avec `organization_id` + `role` depuis l'invitation (ou NULL si pas d'invitation)
- Marque l'invitation comme acceptee (`accepted_at = NOW()`)
- Backfill : boucle DO sur `auth.users LEFT JOIN profiles_` pour creer les profils manquants des utilisateurs existants

**Auth callback safeguard `src/app/auth/callback/route.ts` :**
- `ensureProfile()` appele apres `exchangeCodeForSession`
- Belt-and-suspenders : rattrape les cas ou le trigger DB n'a pas encore cree le profil (race condition, utilisateurs pre-existants)
- Utilise `service_role` pour bypasser le RLS lors de la creation du profil
- Non-bloquant : un echec ne casse pas le flux d'authentification

**Shared helpers `_shared/profile-helpers.ts` (NOUVEAU) :**
- `findValidInvitation()` : filtre invitations valides, case-insensitive, trim, retourne la plus recente
- `buildProfileCandidate()` : construit le profil avec org de l'invitation ou null + role par defaut `member`

**Tests : 14 nouveaux tests (473 total) :**
- findValidInvitation : 10 tests (match, no match, expired, accepted, case-insensitive, trim, multi-invitation priority, skip expired, boundary expires_at = NOW)
- buildProfileCandidate : 4 tests (with invitation org+role, null org, default member, viewer role)

---

## Default Playbooks Seeding v1 (2026-03-09)

Systeme de seeding automatique de 9 playbooks templates pour chaque nouvelle organisation. Bases sur les scores (churn_risk, health, expansion, usage) pour couvrir tous les segments cles.

**Migration `20260309000003_seed_default_playbooks.sql` :**
- Fonction `seed_default_playbooks(p_org_id)` SECURITY DEFINER : insere 9 playbooks templates
- Trigger `seed_playbooks_on_org_created` sur `organizations` AFTER INSERT
- Backfill : boucle DO sur les orgs sans playbooks

**9 playbooks templates (source=system, is_template=true, status=draft) :**

| # | Titre | Categorie | Criteres scoring | Priorite |
|---|-------|-----------|-----------------|----------|
| 1 | Prevention churn — Comptes enterprise | churn_prevention | churn_risk >= 70, plan in [growth, enterprise], MRR >= 500€ | critical |
| 2 | Relance comptes inactifs | reactivation | usage <= 20, health <= 40 | high |
| 3 | Detection opportunite d'expansion | expansion | expansion >= 70, health >= 60 | medium |
| 4 | Onboarding nouveaux comptes | onboarding | health <= 50 | high |
| 5 | Suivi renouvellement contrat | renewal | MRR >= 300€ | high |
| 6 | Recuperation comptes perdus | winback | churn_risk >= 90 | medium |
| 7 | Alerte churn risque eleve | churn_prevention | churn_risk >= 70 | critical |
| 8 | Suivi sante comptes growth | churn_prevention | health <= 50, plan = growth | high |
| 9 | Upsell sieges — comptes satures | expansion | expansion >= 65, health >= 55 | medium |

**Shared helpers `_shared/playbook-seed-helpers.ts` (NOUVEAU) :**
- `getDefaultPlaybookTemplates()` : retourne les 9 templates (fonctions pures, pas de DB)
- `getTemplatesByCategory()` : filtre par categorie
- `getTemplateCategories()` : 6 categories uniques
- `validateTemplates()` : validation structure (titre, actions sequentielles, eligibility)

**Tests : 25 nouveaux tests (498 total) :**
- Templates : count 9, source=system, is_template=true, status=draft, actions non vides, orders sequentiels, titres uniques
- Scoring coverage : churn_risk, health, expansion, usage, mrr_cents tous couverts
- Categories : 3 churn_prevention, 2 expansion, 1 onboarding, 1 renewal, 1 winback, 1 reactivation
- Validation : valid, missing title, empty actions, non-sequential orders, no conditions

---

## Segment Alignment + HubSpot API Key v1 (2026-03-09)

Alignement des filtres de segment avec scoring.ts + connexion HubSpot par cle API Private App.

**Segment Alignment :**
- `SEGMENT_FILTERS` dans `segment-export-helpers.ts` realigne avec `determineSegmentTypes()` de `scoring.ts`
- 6 segments corriges sur 7 (impayes reste un proxy score-based — segment_memberships est la source de verite)

| Segment | Avant (incorrect) | Apres (aligne scoring.ts) |
|---------|-------------------|--------------------------|
| champions | `health > 80 AND expansion > 70` | `health >= 80 AND churn < 50` |
| en_expansion | `expansion > 75` | `expansion >= 70 AND health 60-79 AND churn < 50` |
| stables | `health 60-80 AND churn < 30` | `mrr > 0 AND churn < 50 AND health < 80 AND NOT en_expansion` |
| a_risque_leger | `health 40-59 OR churn 30-50` | `churn 50-69 AND mrr > 0` |
| en_danger_critique | `health < 40 OR churn > 70` | `churn >= 70 AND mrr > 0` |
| en_churn | `churn > 90` | `mrr = 0` |

**HubSpot API Key Connection :**
- `validateHubSpotApiKey()` dans `credential-helpers.ts` : prefixe `pat-`, min 30 chars
- Route `POST /hubspot/api-key` dans `integration-oauth` : valide cle → Vault → upsert integration → trigger sync
- `sync-hubspot` : support `source.type === 'api_key'` (meme Bearer token, pas de difference API)
- Pipeline : validate format → HubSpot API check → Vault store → upsert `organization_integrations` (method: api_key) → update portal_id → fire-and-forget sync

**Tests : 24 nouveaux tests (522 total) :**
- validateHubSpotApiKey : 9 tests (pat- prefix, regions, rejection, boundary 30/29, trim, empty)
- resolveCredentialSource HubSpot api_key : 4 tests (happy path, no expiry check, vault missing, null portal)
- Segment filters : 11 tests recrits pour aligner avec scoring.ts (boundaries, null handling, mrr checks)

---

## Usage Score Suspension V1 (2026-03-10)

Le score d'usage produit est suspendu pour la V1. Le tracker n'est pas encore integre chez les clients beta. Plutot que d'afficher un score neutre a 50 qui fausse le Health Score global, la dimension est exclue du calcul.

**Migration `20260310000001_add_usage_tracker_connected.sql` :**
- Colonne `usage_tracker_connected BOOLEAN NOT NULL DEFAULT FALSE` sur `accounts`
- Mise a jour par `calculate-scores` a chaque run

**`_shared/scoring.ts` — calcHealthScore dual-mode :**
- Nouvelle signature : `calcHealthScore(params: HealthScoreParams)` (objet)
- `usageTrackerConnected = false` → 3 dimensions : Financial 34% + Engagement 33% + Contract 33%
- `usageTrackerConnected = true` → 4 dimensions : Usage 35% + Financial 25% + Engagement 20% + Contract 20%
- `HealthScoreParams` : interface exportee (`financialScore`, `engagementScore`, `contractScore`, `usageScore?`, `usageTrackerConnected`)

**`_shared/scoring.ts` — calcChurnRiskScore :**
- 5e parametre optionnel `usageTrackerConnected?: boolean`
- Le facteur "+20 si 0 jours actifs" ne s'applique que si `usageTrackerConnected === true`
- Backwards compatible : `undefined` = pas de penalite (V1 par defaut)

**`calculate-scores/index.ts` :**
- `detectUsageTrackerConnected()` : query `usage_events` des 30 derniers jours par org (SELECT id LIMIT 1)
- `scoreAccountPure()` : recoit et propage `usageTrackerConnected`
- Si tracker deconnecte : `product_usage_score = NULL` (pas 0, pas 50)
- Mise a jour `accounts.usage_tracker_connected` a chaque run de scoring

**Tests : 7 nouveaux tests (529 total) :**
- calcHealthScore 4D : formule 35/25/20/20, bornes 0 et 100 (3 tests adaptes)
- calcHealthScore 3D : formule 34/33/33, usage ignore meme si fourni, bornes 0/100, range (5 tests)
- calcChurnRiskScore : +20 seulement si tracker connecte, pas si false, pas si undefined (3 tests adaptes)

---

## Playbook Dynamic Eligible Count v1 (2026-03-10)

L'endpoint `playbook-crud` retourne maintenant un `current_eligible_count` dynamique pour chaque playbook. Avant, les compteurs `accounts_targeted`/`accounts_eligible` etaient des KPIs cumulatifs incrementes uniquement apres execution — toujours a 0 pour les playbooks non executes.

**`_shared/playbook-engine.ts` — 2 nouvelles fonctions pures :**
- `countEligibleAccounts(criteria, accounts)` : evalue eligibility_criteria contre un tableau de comptes, retourne le count
- `enrichPlaybooksWithEligibleCount(playbooks, accounts)` : enrichit chaque playbook avec `current_eligible_count`

**`playbook-crud/index.ts` — enrichissement GET list & detail :**
- `handleList` : charge les comptes de l'org (si au moins 1 playbook a des eligibility_criteria), evalue chaque playbook via `enrichPlaybooksWithEligibleCount()`, retourne `current_eligible_count` dans la reponse
- `handleGetOne` : idem pour le detail d'un playbook, evalue `evaluateConditions()` sur les comptes de l'org
- Query comptes : `.select(scoring fields).eq(org_id).limit(10000)` — une seule query partagee pour tous les playbooks

**Champ retourne :**
```json
{
  "id": "pb-uuid",
  "title": "Prevention churn",
  "current_eligible_count": 12,
  "accounts_targeted": 0,
  ...
}
```
- `current_eligible_count` : nombre de comptes qui matchent ACTUELLEMENT les eligibility_criteria (dynamique)
- `accounts_targeted` : ancien KPI cumulatif post-execution (inchange)

**Tests : 14 nouveaux tests (543 total) :**
- countEligibleAccounts : null/undefined/empty criteria, AND/OR, no match, empty accounts, null fields (8 tests)
- enrichPlaybooksWithEligibleCount : multi-playbook, no criteria, field preservation, empty arrays (6 tests)

---

## Fix Segment Detail Empty (2026-03-10)

Bug critique : la page detail d'un segment affichait 0 comptes alors que la page liste affichait le bon nombre (ex: "A risque leger" = 101 comptes sur la liste, 0 sur le detail).

**Cause racine : mismatch `onConflict` dans `calculate-scores`**

La table `segment_memberships` a une contrainte unique sur `(segment_id, account_id)` (2 colonnes), mais l'upsert dans `assignSegments()` specifiait `onConflict: 'organization_id,segment_id,account_id'` (3 colonnes). Ce mismatch faisait echouer l'upsert silencieusement, laissant `segment_memberships` vide.

**Impact :**
- Page liste segments : fonctionnait (filtrage in-memory sur scores via `SEGMENT_FILTERS`)
- Page detail segment : vide (utilise RPC `get_segment_accounts()` qui JOIN sur `segment_memberships`)
- Export CSV segment : fonctionnait (filtrage in-memory identique a la liste)

**Fix applique :**
- `calculate-scores/index.ts` ligne 337 : `onConflict: 'segment_id,account_id'` (aligne avec la contrainte DB)

**Apres deploy :**
- Le prochain run de `calculate-scores` peuplera `segment_memberships` correctement
- La page detail affichera les memes comptes que la liste
- Aucune migration necessaire (la contrainte DB etait deja correcte)

---

## UX Audit Phase 1+2 (2026-03-10)

Refonte frontend complete : sidebar navigation, pages manquantes, dashboard actionnable, empty states guides.

**Composants crees :**
- `Sidebar.tsx` : navigation persistante avec etat actif, logout, icones Lucide
- `ScoreBadge.tsx` : badges colores semantiques (Sain/Attention/Critique, Eleve/Modere/Faible)
- `EmptyState.tsx` : composant reutilisable avec icone, titre, description, CTA optionnel
- `Breadcrumbs.tsx` : fil d'Ariane pour pages de detail

**Foundation :**
- `src/lib/types/accounts.ts` : type Account aligne avec la table Supabase
- `src/lib/segment-queries.ts` : filtres de segment in-memory (source de verite = scoring.ts), metadata couleurs/labels, `formatMrr`, `formatScore`

**Layout :**
- `src/app/dashboard/layout.tsx` : layout avec sidebar (auth check + profile fetch dans le layout, plus dans chaque page)
- `loading.tsx` et `error.tsx` adaptes au layout sidebar (suppression header duplique)

**Dashboard enrichi (`/dashboard`) :**
- KPI cards avec icones (Users, CreditCard, AlertTriangle)
- 4 segment quick-links colores (Champions, En expansion, Stables, A risque leger)
- Widget "Comptes a risque" : top 5 comptes par churn_risk desc avec ScoreBadge
- Widget "Opportunites d'expansion" : top 5 comptes par expansion_score desc
- Empty state guide vers Parametres quand aucune synchronisation

**Nouvelles pages :**

| Route | Contenu |
|-------|---------|
| `/dashboard/segments` | 8 cartes segment avec count, MRR total, sante moyenne, lien detail |
| `/dashboard/segments/[segment]` | Detail avec filtrage in-memory (meme source que la liste), tableau comptes, stats, export CSV, breadcrumbs |
| `/dashboard/accounts` | Liste complete des comptes avec tri MRR desc, scores colores |
| `/dashboard/playbooks` | Cartes playbook avec statut, priorite, eligible count, template badge |
| `/dashboard/insights` | Liste insights avec icones par type, priorite, statut, impact MRR, action recommandee |
| `/dashboard/settings` | Statut integrations (Stripe/HubSpot), config webhook, info scoring V1/futur |

**Segment detail — alignement source de donnees :**
- La page detail utilise desormais le meme filtrage in-memory (`SEGMENT_FILTERS`) que la page liste
- Plus de dependance a `segment_memberships` ni a la RPC `get_segment_accounts()`
- Coherence garantie : memes comptes affiches sur la liste et le detail

**Empty states implementes :**
- Dashboard sans sync → guide vers Parametres
- Comptes vides → guide vers configuration Stripe
- Playbooks vides → explication du fonctionnement
- Insights vides → explication du timing de generation
- Segment vide → message contextuel avec nom du segment

---

## Page Aujourd'hui — Actions groupees par priorite v1 (2026-03-10)

Refonte de la page "Aujourd'hui" : remplacement de la liste plate de 107 cartes identiques par un regroupement par priorite (P0/P1/P2) avec filtres et resume.

**Shared helpers `_shared/today-actions-helpers.ts` (NOUVEAU) :**
- `computeTodayActions(accounts, playbooks)` : matche comptes contre playbooks actifs, deduplique par account_id, retourne TodayAction[]
- `buildTodayActionsSummary(actions)` : regroupe par priorite, calcule MRR a risque (P0+P1), compte par categorie
- `getTopActionsByPriority(actions, limit)` : top N par groupe de priorite (vue collapsed)
- `sortTodayActions(actions)` : tri P0 > P1 > P2, MRR desc intra-priorite
- `computeTriggerReasons(account)` : raisons humaines (churn critique, sante faible, renouvellement, expansion, MRR zero)
- `priorityLabel()` / `categoryLabel()` : labels francais
- Reutilise `evaluateConditions` de `playbook-engine.ts` et `computePriority`/`computeDaysToRenewal` de `export-helpers.ts`

**Sidebar (`src/components/Sidebar.tsx`) :**
- Ajout nav item "Aujourd'hui" en premiere position (icone CalendarCheck)
- Badge rouge avec compteur d'actions (99+ si > 99, masque si 0)
- Prop `todayActionCount?: number | null` ajoutee a SidebarProps

**Frontend prompt `docs/PROMPT_FRONTEND_TODAY_V1.md` :**
- Architecture complete de la page `/dashboard/today`
- 4 KPI cards resume (P0 count, P1 count, P2 count, MRR a risque)
- 3 sections collapsibles par priorite (P0 ouvert, P1 ouvert, P2 ferme)
- Top 5 par section avec "Voir les N restants"
- Vue tableau condensee (pas de cartes) pour scanabilite
- Filtres rapides : priorite, segment, categorie playbook, MRR minimum
- Logique complete de matching, priority, trigger_reasons documentee
- Export CSV/JSON via Edge Function existante

**Tests : 32 nouveaux tests (575 total) :**
- computeTriggerReasons : churn critique, modere, sante faible, renouvellement, expansion, MRR zero, healthy (0 reasons), null scores (8 tests)
- computeTodayActions : no match, match, multi-playbook dedup, same playbook dedup, multi-accounts, priority computation, null criteria, trigger_reasons (8 tests)
- sortTodayActions : priority order, MRR desc intra-priority, immutability (3 tests)
- buildTodayActionsSummary : by_priority counts, MRR at risk P0+P1, by_category, sorted output, empty (5 tests)
- getTopActionsByPriority : limit per group, empty, MRR sort within group (3 tests)
- priorityLabel : P0/P1/P2 labels (3 tests)
- categoryLabel : known categories, unknown fallback (2 tests)

---

## Playbook Detail Backend v1 (2026-03-11)

Backend complet pour la page de detail d'un playbook : RPC consolidee, transition de statut validee, helpers pures.

**Migration `20260311000001_alter_playbook_executions_add_mrr_columns.sql` :**
- Ajout `mrr_recovered_cents INTEGER NOT NULL DEFAULT 0` sur `playbook_executions`
- Ajout `mrr_expansion_cents INTEGER NOT NULL DEFAULT 0` sur `playbook_executions`
- Permet le suivi MRR par execution (au lieu du cumul sur `playbooks` uniquement)

**RPC `get_playbook_full_detail(p_playbook_id)` (20260311000002) :**
- SECURITY DEFINER + SET search_path = public
- Verification explicite `user_organization_id()` en premiere instruction
- Retourne NULL si playbook inexistant ou cross-tenant
- JSON consolide : playbook (15 champs) + stats (10 metriques) + affected_accounts_summary (total, mrr_at_risk, by_urgency) + conditions + actions
- Stats : targeted/reached/converted counts, mrr_recovered/expansion, executions total/completed/failed/in_progress
- eligible_count : calcule dynamiquement via filtrage SQL des conditions eligibility_criteria
- affected_accounts_summary.by_urgency : urgent (churn >= 70), watch (40-69), stable (< 40)
- Filtres SQL dynamiques : churn_risk_score, health_score, expansion_score, mrr_cents, product_usage_score, plan_tier
- Zero-PII : aucun stripe_customer_id/email dans le retour, uniquement des agregats

**RPC `transition_playbook_status(p_playbook_id, p_target_status)` (20260311000003) :**
- SECURITY DEFINER + SET search_path = public
- Machine a etats validee :
  - draft → active, archived ✅
  - active → draft, archived ✅
  - paused → active, archived ✅
  - completed → archived ✅
  - archived → * ❌ (interdit)
- Retourne `{success: true, new_status}` ou `{success: false, error}`
- Met a jour `activated_at` (premiere activation) et `deactivated_at` (archivage)
- Validation statut cible (rejet des valeurs inconnues)

**Adaptations schema reel :**
- `conditions` → `eligibility_criteria` (JSONB `{operator, conditions:[]}`)
- `automation_type` → `playbook_type` (manual, automated, semi_automated, template)
- `category` → `template_category`
- `pe.status` → `pe.execution_status` (pending, running, completed, failed, cancelled)
- `pe.converted` → `pe.account_converted`

**Shared helpers `_shared/playbook-detail-helpers.ts` (NOUVEAU) :**
- `classifyUrgency(churnRiskScore)` : urgent/watch/stable (boundaries 70/40)
- `buildAffectedAccountsSummary(accounts)` : total, mrr_at_risk_cents, by_urgency
- `buildConditionLabel(condition)` : label francais lisible (ex: "Score de risque churn ≥ 70", "MRR ≥ 500 €")
- `buildConditionsDisplay(eligibilityCriteria)` : conditions avec labels pour l'UI
- `buildActionsDisplay(actions)` : actions avec step/type/label/detail pour l'UI
- `isTransitionAllowed(current, target)` : validation pure des transitions
- `getAllowedTransitions(status)` : liste des cibles autorisees
- `computeExecutionStats(executions)` : stats agregees avec deduplication par account_id
- Labels francais : 8 champs, 8 operateurs, 8 types d'action

**Tests : 42 nouveaux tests (617 total) :**
- classifyUrgency : urgent/watch/stable, null, boundaries 70/69 et 40/39 (6 tests)
- buildAffectedAccountsSummary : mixed urgency, empty, null mrr, null churn (4 tests)
- buildConditionLabel : churn gte, mrr euros, plan in, unknown field, health lte (5 tests)
- buildConditionsDisplay : null, undefined, multi-conditions avec labels (3 tests)
- buildActionsDisplay : null, undefined, multi-actions, sort by order, empty detail (5 tests)
- isTransitionAllowed : 10 transitions (draft→active, archived→active interdit, etc.)
- getAllowedTransitions : draft targets, archived empty, unknown empty (3 tests)
- computeExecutionStats : mixed, empty, dedup accounts, zero mrr, null mrr, pending as in_progress (6 tests)

---

## Backlog

- Propager `contract_end_date` dans `stripe-webhook`
- NPS : collecte + intégration scoring (V2)
- HubSpot Static List Push (playbooks actionnables one-click)
- Toast notifications (remplacer les messages inline ephemeres)
- Recherche globale (Cmd+K) par stripe_customer_id / hubspot_company_id
- Graphiques de tendance (health score, MRR sur 30j)
- Responsive mobile (menu hamburger, tableaux scrollables)
