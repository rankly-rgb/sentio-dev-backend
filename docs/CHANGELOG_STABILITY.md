# Changelog Stabilité — Sentio AI SaaS FR

Historique complet des audits de stabilité et corrections. Extrait du CLAUDE.md le 2026-03-05.

---

## Devise — retrait des symboles € codés en dur (2026-08-02, E1.2/E1.3 partiel)

Audit préalable (audit rétention 2026-08, décision produit D4 — anglais/en-US intégral) : la conversion FR→EN de l'UI et du contenu généré était déjà faite avant cet audit (aucun toggle FR/EN, `src/i18n/en.ts` seul fichier i18n, aucune chaîne française dans le contenu généré `generate-insights`/`account-summary`). Le seul écart réel trouvé : le symbole `€` codé en dur dans 6 fichiers backend, alors qu'aucune colonne de devise n'existe nulle part dans le schéma (`organizations`/`accounts` n'ont pas de champ `currency` — seules `invoices`/`subscriptions` stockent une devise Stripe par transaction).

**Changements** (symbole `$` par défaut, formatage `en-US` avec séparateurs de milliers ; résolution complète depuis le compte Stripe connecté reste un chantier séparé — aucun champ `currency` org-level n'existe encore pour la porter) :
- `_shared/insight-rules.ts` : `mrrEur` → `mrrUsd`, retourne désormais `$1,234` (le `€` littéral était concaténé séparément à chaque site d'appel)
- `_shared/score-narratives.ts` : `narrativePaymentHealth` (chemin V3 actif) — `€` → `$`. `narrativeFinancial` (V1, zéro appelant — même statut que les fonctions supprimées ci-dessous) non touché, hors scope de ce fix
- `weekly-digest/index.ts` : `formatMrr` retourne `$1,234` ; `accountRow` réutilise `formatMrr` au lieu d'un `Math.round` sans séparateur de milliers (bug de formatage additionnel corrigé au passage)
- `churn-alert/index.ts` : même correction de formatage (séparateurs de milliers + `$`)
- `account-summary/index.ts` : prompt IA — `mrr_euros` renommé `mrr_usd`, `€` → `$` (impacte directement le texte généré par le LLM)
- `export-csv/index.ts` : en-tête CSV `MRR (€)` → `MRR ($)`
- `_shared/connectors/slack.ts` : message Slack sortant (notification playbook vers le Slack du client) — `€` → `$`. Le nom de champ `mrr_eur` du contrat `ConnectorPayload` (payload webhooks sortants Brevo/HubSpot/Mailchimp/etc., documenté dans le changelog "Outbound Webhook System v1") n'est **pas** renommé — c'est un contrat externe déjà documenté, un renommage serait cassant pour des intégrations clientes existantes.

**Non touché intentionnellement** : `stripe-product-mappings-api/index.ts` (déjà correctement conditionné sur `price.currency`, pas un hardcode) ; log d'alerte Slack interne de `sync-stripe` (alerte ops Sentio, pas une sortie produit consommée par l'utilisateur final).

**Tests** : `insight-rules.test.ts`, `churn-alert.test.ts`, `export-csv.test.ts` — assertions `€` → `$` mises à jour.

---

## AI Insights — Contrat de pagination corrigé (2026-08-02, P0.2)

Audit préalable (audit rétention 2026-08) : `insights-crud handleList` retournait `{ insights, total_count, critical_count }` avec des query params `limit`/`offset` (contrat du 2026-07-05 ci-dessous), mais le frontend envoyait `page`/`per_page`/`sort` et lisait `listData?.data`/`listData?.pagination` — contrat cassé des deux côtés, probable cause d'une partie des symptômes de fatigue d'alerte observés (liste d'insights potentiellement vide/mal rendue en prod).

**Changements :**
- `insights-crud/index.ts` : `parseLimit`/`parseOffset` remplacés par `parsePage`/`parsePerPage` (1-indexé, `per_page` défaut 20 / max 100). `handleList` retourne désormais `{ data, pagination: { page, per_page, total_count }, critical_count }`. Le paramètre `sort` est accepté (le frontend l'envoie systématiquement) mais sans effet — le tri reste fixe côté SQL, requis par le `DISTINCT ON` de déduplication.
- `docs/PROMPT_FRONTEND_INSIGHTS_V1.md` mis à jour avec le contrat actuel et un historique des 3 formes successives de cet endpoint.

**Tests** : `supabase/tests/insights-crud.test.ts` — `parsePage`/`parsePerPage` remplacent `parseLimit`/`parseOffset` (mêmes bornes, nouveau défaut `page=1`).

---

## Accounts — priority_label calculé (2026-07-05)

Audit préalable : aucune vue SQL n'existait sur `accounts` (aucun fichier sous `supabase/views/`), et `accounts-api` (seul endpoint de liste de comptes — il n'y a pas de fonction `get-accounts`) sélectionnait directement la table `accounts` sans label de priorité calculé.

**Changements :**
- Migration `20260705000002_accounts_priority_label_view.sql` : vue `accounts_with_priority` (`WITH (security_invoker = true)` pour que la RLS de `accounts` s'applique à tout appelant, y compris hors service_role) — ajoute `priority_label` via `CASE` SQL, non stocké.
- `accounts-api/index.ts` : `handleList` sélectionne désormais depuis `accounts_with_priority` au lieu de `accounts`, ajoute `priority_label` à la liste de colonnes retournées. `handleGetOne` et `handlePatch` inchangés (écriture sur `accounts` directement).

**Règles `priority_label`** (priorité décroissante, exclusif) :
1. `critique` — `churn_risk_score >= 80` OU `health_score <= 30`
2. `surveillance` — `churn_risk_score >= 50` OU `health_score <= 55`
3. `nouveau` — `created_at` < 90 jours ET `churn_risk_score < 50`
4. `stable` — défaut

**Tests** : pas de nouveau test Vitest — la logique vit entièrement en SQL (`CASE` dans la vue), même convention que `list_deduplicated_insights` (voir entrée du 2026-07-05 ci-dessous).

---

## AI Insights — Pagination & Dedup v1 (2026-07-05)

Audit préalable sur `insights-crud` (aucune fonction `get-insights` n'existe — c'est `insights-crud` qui expose la liste). L'endpoint utilisait déjà une pagination (`page`/`per_page`), mais celle-ci divergeait du contrat documenté dans `API_CONTRACTS.md` (`limit`/`offset`). Le tri par défaut était `created_at DESC` (pas de priorisation), et aucune déduplication n'était appliquée : un compte pouvait accumuler plusieurs insights actifs-puis-résolus du même `insight_type` sur des jours différents, qui s'affichaient comme des doublons visuels une fois tous les statuts inclus dans le filtre.

**Contexte DB important** : la migration `20260704000001_fix_duplicate_accounts_and_insights.sql` a déjà posé un index unique `idx_ai_insights_org_account_type_day` interdisant plus d'une ligne par `(organization_id, account_id, insight_type, jour UTC)`, tous statuts confondus — donc les doublons stricts ne peuvent plus être insérés depuis cette date. Le `DISTINCT ON` ajouté ici est un filet de sécurité pour les lignes antérieures à cette contrainte, pas le mécanisme principal.

**Changements :**
- Migration `20260705000001_insights_dedup_rpc.sql` : fonctions SQL `list_deduplicated_insights` / `count_deduplicated_insights` — `DISTINCT ON (account_id, insight_type, created_at::date UTC)` puis tri `priority DESC → mrr_impact_cents DESC → created_at DESC`. Pas de colonne `detected_at` dans ce schéma (comme déjà noté dans la migration du 2026-07-04) — `created_at` utilisé à la place.
- `insights-crud/index.ts` : `handleList` remplace `page`/`per_page` par `limit`/`offset` (défaut 20, max 100) et appelle les deux RPC au lieu d'une query builder directe. Le tri n'est plus paramétrable par `?sort=` (nécessaire pour rendre le `DISTINCT ON` cohérent avec l'`ORDER BY` côté SQL) — aucun frontend ne consommait cet endpoint (vérifié : zéro référence à `insights-crud` sous `/src`), donc pas de rupture réelle.
- Réponse : `{ insights, total_count, critical_count }` remplace `{ data, pagination }`. `critical_count` = insights `active`+`critical` de l'org, indépendant des filtres de la requête — c'est ce champ (pas `total_count`) qui doit alimenter le badge de nav.
- `API_CONTRACTS.md` et `docs/PROMPT_FRONTEND_INSIGHTS_V1.md` mis à jour pour refléter le nouveau contrat (ces docs décrivaient un frontend pas encore construit).

**Tests** : `supabase/tests/insights-crud.test.ts` — 16 tests sur `parseLimit`, `parseOffset`, `parseCsvFilter` (parsing/validation purs ; la déduplication et le tri vivent en SQL et ne sont pas testables via Vitest).

---

## Today Portfolio Status v1 (2026-07-04)

Nouvelle Edge Function `get-today-status` : statut global du portefeuille pour la future page "Aujourd'hui". Fonctionnalité entièrement nouvelle — un audit préalable a confirmé qu'aucune page "Today" ni logique de statut global n'existait sur `main` (le seul champ proche, `health_trend` dans `dashboard-api`, est un delta de tendance KPI, pas un statut qualitatif). Une branche non mergée (`feat/export-playbook-accounts`) contient des helpers `today-actions-helpers.ts` avec une granularité par compte (P0/P1/P2), différente de ce statut agrégé.

### Règles de statut

1. `critical` si au moins 1 `ai_insights` actif avec `priority='critical'`
2. sinon `at_risk` si la part de comptes scorés (`churn_risk_score` non null) avec `churn_risk_score > 70` dépasse 30 %
3. sinon `stable`

### Réponse API

```json
{
  "data": {
    "status": "critical",
    "critical_count": 2,
    "total_mrr_cents": 1284500,
    "champions_count": 12,
    "top_urgent_account": {
      "id": "uuid",
      "name": "Acme Corp",
      "mrr": 49900,
      "risk_score": 82,
      "top_insight": "Facture impayée depuis 20 jours"
    }
  }
}
```

`top_urgent_account` = compte avec `churn_risk_score > 70` au MRR le plus élevé (`null` si aucun). `top_insight` = titre du plus prioritaire des insights actifs liés à ce compte (`''` si aucun — jamais `null`, pour que le frontend puisse appeler des méthodes string sans vérification).

`total_mrr_cents` = somme de `mrr_cents` sur tous les comptes de l'org (`accounts` n'a pas de colonne `status` — un compte churné a déjà `mrr_cents = 0`, donc la somme brute équivaut à un filtre "actif"). `champions_count` = memberships actifs du segment système `account_segments.segment_type = 'champions'` (valeur exacte de la CHECK constraint ; `accounts` n'a pas de colonne `segment` directe, l'appartenance passe par `segment_memberships`).

### Corrections post-revue (avant merge)

Un premier passage de revue avait proposé `total_mrr_cents` via `accounts.status = 'active'` et `champions_count` via `accounts.segment = 'champion'` — ni la colonne `status` ni la colonne `segment` n'existent sur `accounts` (vérifié dans les migrations). Corrigé pour utiliser le schéma réel : somme JS de `mrr_cents` (convention déjà suivie par `onboarding-first-win`/`weekly-digest`) et jointure `account_segments` → `segment_memberships` (convention suivie par `dashboard-api`/`account-summary`), avec le slug pluriel `champions` qui correspond à la CHECK constraint.

### Fichiers

| Fichier | Rôle |
|---------|------|
| `supabase/functions/get-today-status/index.ts` | Edge Function GET, `verify_jwt=false` (JWT vérifié dans le code) |
| `supabase/tests/get-today-status.test.ts` | 16 tests : `determineTodayStatus`, `selectTopUrgentAccount`, `selectTopInsightTitle`, `calcTotalMrrCents` |

---

## HubSpot Playbook Dispatch Audit (2026-05-28)

Audit complet de la fonctionnalité de dispatch playbook vers HubSpot. 8 corrections réparties en P0 (bugs bloquants), P1 (performance) et P2 (robustesse).

### Mapping de la séquence HubSpot

```
POST /playbook-execute (ou cron playbook-scheduler)
  └─ dispatchAction() [action-dispatcher.ts]
       └─ getBatchCompanyContacts(ids[]) → POST /crm/v3/associations/company/contact/batch/read
       └─ enrollInSequence(contactId, sequenceId, senderId)
            POST /automation/v4/sequences/{sequenceId}/enrollments
```

Les contacts enrollés apparaissent dans **HubSpot Sales > Sequences** et sur l'onglet Sequences de chaque fiche Contact. Sentio déclenche uniquement l'enrollment — le contenu et le timing des emails sont définis dans la séquence HubSpot.

### P0 — Bugs critiques corrigés

| Bug | Fichier | Correction |
|-----|---------|------------|
| `isTransient` ne détectait que les timeouts, pas les 429 | `hubspot-client.ts` | Détecte maintenant 429/502/503 |
| `enrollInSequence` + `updateCompanyProperties` retournaient `{ success: false }` sur 429 sans retry | `hubspot-client.ts` | Throw sur 429 à l'intérieur du callback `retryWithBackoff` |
| `send_email` dans playbook standard retournait `completed` sans rien envoyer | `action-dispatcher.ts` | Retourne `failed` avec message explicite |

### P1 — Performance

| Amélioration | Avant | Après |
|---|---|---|
| Récupération contacts HubSpot | 1 appel GET par compte (N+1) | `getBatchCompanyContacts` : POST batch, 100 companies/req, 2 appels max pour 200 comptes |
| Retry rate-limitées | `waitForToken()` avant `retryWithBackoff` seulement (retries non throttlés) | `waitForToken()` à l'intérieur du callback — chaque tentative est rate-limitée |
| `has_more` pour segments | Toujours `false` si `segment_id` | Correct : `accountIds.length >= MAX_ACCOUNTS_PER_RUN` |

### P2 — Robustesse

| Amélioration | Détail |
|---|---|
| Rate limiter | Réduit de 5 à 3/sec — HubSpot standard = 10/sec, marge de 40 % pour instances Deno concurrentes |
| KPI TOCTOU | Remplacé read-then-write par `supabase.rpc('increment_playbook_kpis')` — `UPDATE SET col = col + N` atomique |
| Exécution séquentielle | Boucle `for (account)` → `processAccount` closure + `Promise.allSettled` par chunks de 5 dans `playbook-execute` et `playbook-scheduler` |

### Fichiers modifiés

| Fichier | Changements |
|---------|-------------|
| `_shared/hubspot-client.ts` | `isTransient` étendu, `waitForToken` dans callbacks, throw 429, `getBatchCompanyContacts` |
| `_shared/action-dispatcher.ts` | `contactsCache?: Map<string, string[]>` dans `DispatchContext`, case `send_email` explicite |
| `playbook-execute/index.ts` | Pre-fetch batch, `processAccount` + chunks parallèles, KPI via RPC, `has_more` corrigé |
| `playbook-scheduler/index.ts` | Pre-fetch batch, `processAccount` + chunks parallèles, KPI via RPC |
| `migrations/20260528000001_increment_playbook_kpis.sql` | Fonction `increment_playbook_kpis(p_playbook_id, eligible, targeted, reached)` |

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
