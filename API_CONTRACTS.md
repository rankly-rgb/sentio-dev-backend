# API Contracts — Sentio AI Backend

**Source de vérité** pour le repo frontend Next.js.  
Projet Supabase : `upqakxuatlshhqiagbqw` (eu-west)  
Base URL : `https://upqakxuatlshhqiagbqw.supabase.co/functions/v1`

> **Zero-PII** : aucune de ces fonctions ne retourne ni ne persiste d'email,
> prénom, nom de personne physique, IP ou téléphone.

---

## Onboarding V2 — Étapes comportementales

### 1. create-organization-with-invitation

Créer l'organisation, le profil owner et les 4 comptes démo immédiatement
après `supabase.auth.signUp()`.

| | |
|---|---|
| **URL** | `https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/create-organization-with-invitation` |
| **Méthode** | `POST` |
| **Auth** | `Authorization: Bearer <jwt_utilisateur>` |

**Body**
```json
{
  "user_id": "uuid",
  "email": "transit uniquement — jamais persisté",
  "company_name": "Acme Corp"
}
```

**Response 200**
```json
{
  "organization_id": "uuid",
  "onboarding_step": "promise",
  "has_demo_data": true
}
```

**Codes d'erreur**

| Code | Cas |
|------|-----|
| `400` | `user_id` ou `company_name` manquant / invalide |
| `401` | JWT absent ou invalide |
| `403` | `user_id` ne correspond pas au JWT |
| `409` | Une organisation existe déjà pour cet utilisateur |
| `500` | Erreur base de données |

---

### 2. update-onboarding-step

Enregistrer la progression comportementale. Ordre imposé :
`promise → stripe → revelation → invested → hubspot → completed`.
Un saut de plus de 2 étapes retourne 422.

| | |
|---|---|
| **URL** | `https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/update-onboarding-step` |
| **Méthode** | `POST` |
| **Auth** | `Authorization: Bearer <jwt_utilisateur>` |

**Body**
```json
{ "step": "promise | stripe | revelation | invested | hubspot | completed" }
```

**Effets secondaires automatiques**

| Step | Champ mis à jour |
|------|-----------------|
| `promise` | `organizations.promise_seen_at = NOW()` |
| `revelation` | `organizations.first_revelation_at = NOW()` |
| `completed` | `organizations.onboarding_completed = true` |

**Response 200**
```json
{ "onboarding_step": "stripe", "onboarding_completed": false }
```

**Codes d'erreur**

| Code | Cas |
|------|-----|
| `400` | `step` invalide ou absent |
| `401` | JWT absent ou invalide |
| `404` | Organisation introuvable |
| `422` | Transition invalide (saut d'étapes interdit) |
| `500` | Erreur base de données |

---

### 3. get-onboarding-status-v2

Snapshot complet de l'état comportemental. À appeler au chargement de
chaque page protégée pour décider la redirection.

| | |
|---|---|
| **URL** | `https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/get-onboarding-status-v2` |
| **Méthode** | `GET` |
| **Auth** | `Authorization: Bearer <jwt_utilisateur>` |

**Response 200**
```json
{
  "organization_id": "uuid",
  "onboarding_step": "promise",
  "onboarding_completed": false,
  "has_demo_data": true,
  "promise_seen": false,
  "first_revelation_done": false
}
```

**Codes d'erreur** : `401`, `404`, `500`

---

### 4. get-accounts-summary

Révélation progressive (principe Eyal/Hooked). **Deux appels distincts**
pour l'effet de surprise frontend.

| | |
|---|---|
| **URL** | `https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/get-accounts-summary` |
| **Méthode** | `GET` |
| **Auth** | `Authorization: Bearer <jwt_utilisateur>` |

**mode=count** — `?mode=count` — Premier écran : "X comptes détectés"
```json
{ "total_accounts": 23, "is_demo": false }
```

**mode=risk** — `?mode=risk` — Deuxième écran (après 2s frontend)

Utilise les seuils de `org_preferences` (défaut : `danger=40`, `at_risk=60`).
```json
{
  "at_risk_count": 5,
  "danger_count": 3,
  "past_due_count": 1,
  "top_danger_accounts": [
    {
      "account_id": "uuid",
      "company_name": "Nexio",
      "health_score": 31,
      "mrr_cents": 110000,
      "segment": "En danger",
      "is_demo": false
    }
  ]
}
```
> `top_danger_accounts` : max 5 comptes, triés `health_score ASC`.

**Codes d'erreur** : `400` (mode invalide), `401`, `500`

---

### 5. save-org-preferences

Personnalisation (investissement utilisateur). Tous les champs sont optionnels.
Déclenche automatiquement `onboarding_step → invested` si l'étape courante
est `stripe` ou `revelation`.

| | |
|---|---|
| **URL** | `https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/save-org-preferences` |
| **Méthode** | `POST` |
| **Auth** | `Authorization: Bearer <jwt_utilisateur>` |

**Body** (tous optionnels)
```json
{
  "danger_threshold": 40,
  "at_risk_threshold": 60,
  "champion_threshold": 80,
  "segment_name_champions": "Champions",
  "segment_name_at_risk": "Slightly at Risk",
  "segment_name_danger": "At Risk",
  "segment_name_stable": "Stable",
  "alert_channel": "slack"
}
```

**Contraintes**

| Champ | Contrainte |
|-------|------------|
| `danger_threshold` | Entier 10–60 |
| `at_risk_threshold` | Entier 30–80 |
| `champion_threshold` | Entier 60–100 |
| `alert_channel` | `none` \| `slack` \| `email` \| `both` |

**Response 200**
```json
{ "saved": true, "onboarding_step": "invested" }
```

**Codes d'erreur** : `400` (valeur hors contrainte), `401`, `500`

---

## Langue produit

Le produit est standardisé sur l'anglais américain (en-US) pour toutes les chaînes d'affichage (labels, messages d'erreur, emails). Le système de locale par organisation (`organizations.locale`, `get-organization-locale`, `update-organization-locale`, `org-settings`, dictionnaire de traductions) a été retiré — ces endpoints n'existent plus.

---

## Playbooks

### playbook-crud (GET list)

`GET /functions/v1/playbook-crud`

Retourne la liste paginée avec les champs de contenu.

**Champs ajoutés à chaque objet playbook :**

| Champ | Type | Description |
|-------|------|-------------|
| `display_name` | `string` | Titre à afficher (jamais null) |
| `display_description` | `string` | Description à afficher (jamais null) |
| `title_en` | `string \| null` | Titre explicite (colonne historique) |
| `description_en` | `string \| null` | Description explicite (colonne historique) |

**Chaîne de fallback :** `title_en` → `title` (legacy)

---

### playbook-crud (GET single)

`GET /functions/v1/playbook-crud?id=<uuid>`

Retourne tous les champs bruts (`title_en`, `description_en`) plus les champs résolus `display_name` / `display_description`.

---

### playbook-crud (POST create)

`POST /functions/v1/playbook-crud`

**Body** — au moins un champ `title` ou `title_en` obligatoire :

```json
{
  "title": "string (legacy — copié dans title_en si absent)",
  "title_en": "string?",
  "description": "string? (legacy)",
  "description_en": "string?"
}
```

**Règle de validation :** au moins un parmi `title`, `title_en` doit être non-vide.

**Comportement legacy :** si seul `title` est fourni, il est copié dans `title_en`.

---

### playbook-crud (PUT/PATCH update)

`PUT /functions/v1/playbook-crud?id=<uuid>`

Accepte les mêmes champs que le POST. Seuls les champs fournis sont mis à jour.

```json
{
  "title_en": "string?",
  "description_en": "string?"
}
```

---

## Fonctions existantes (inchangées)

### onboarding-status (GET/PATCH)

État technique de l'onboarding (sync Stripe, scoring).
Complémentaire à `get-onboarding-status-v2`.

| | |
|---|---|
| **URL** | `https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/onboarding-status` |
| **GET** | Retourne `stripe_connected`, `stripe_sync_in_progress`, `first_score_calculated`, `current_step`, `at_risk_count`, `billing_profile`, `billing_profile_flags` |
| **PATCH** | `{ field: 'first_win_seen' \| 'onboarding_completed', value: true }` |

**`billing_profile`** (Phase 3, docs/openspec.md §11) : `'standard' \| 'needs_review' \| null`. `null` tant qu'aucun sync Stripe complet n'a encore tourné pour l'org (colonne DB par défaut `'standard'`, mais ce champ de réponse reflète explicitement "pas encore de signal" plutôt que d'implicitement laisser croire à un profil vérifié). `'needs_review'` dès que `sync-stripe` a détecté un signal de configuration Stripe non-standard sur ce dernier run (voir `billing_profile_flags`) : comptes facturés manuellement (`invoice_only_accounts`), abonnements usage-based (`metered_subscriptions`), prix sans `unit_amount` (`null_unit_amount_prices`), plusieurs devises (`multi_currency`), ou `subscription_schedules` détectés (`has_subscription_schedules`). `multi_item_subscriptions` (comptage informatif) n'influence jamais ce statut — les abonnements multi-items sont correctement chiffrés depuis le moteur MRR v2.

**`billing_profile_flags`** : `{ metered_subscriptions: number, multi_item_subscriptions: number, null_unit_amount_prices: number, invoice_only_accounts: number, multi_currency: boolean, has_subscription_schedules: boolean } | null`.

### integrations-config (GET/POST)

Sauvegarder / vérifier les clés API Stripe et HubSpot.
**Le POST (stripe) déclenche automatiquement sync + scoring.**

| | |
|---|---|
| **URL** | `https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/integrations-config` |
| **POST body** | `{ "provider": "stripe" \| "hubspot", "api_key": "sk_..." }` |
| **GET response** | `{ "data": { "stripe_configured": true, "hubspot_configured": false } }` |

### onboarding-first-win (GET)

Top 3 comptes à risque pour le "aha moment".

| | |
|---|---|
| **URL** | `https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/onboarding-first-win` |
| **Response** | `{ "data": { "total_accounts", "at_risk_accounts": [...], "mrr_at_risk", "global_health_score" } }` |

---

## Flux onboarding complet

```
signUp()
  └─► POST /create-organization-with-invitation
        └─► onboarding_step = 'promise', 4 comptes démo créés

  (popup re-motivation affiché → user choisit d'agir)
  └─► POST /update-onboarding-step { step: 'promise' }

  (user entre sa clé Stripe dans /onboarding/stripe)
  └─► POST /integrations-config { provider: 'stripe', api_key: 'sk_...' }
        └─► fire-and-forget : sync Stripe → calculate-scores automatiques
  └─► POST /update-onboarding-step { step: 'stripe' }

  (page /onboarding/sync — polling GET /onboarding-status)
  ← stripe_sync_in_progress: true → spinner
  ← stripe_connected: true + first_score_calculated: true → continuer

  (révélation progressive)
  └─► GET /get-accounts-summary?mode=count  ← "23 comptes détectés"
      [2 secondes pause frontend]
  └─► GET /get-accounts-summary?mode=risk   ← "3 comptes en danger"
  └─► POST /update-onboarding-step { step: 'revelation' }

  (user personnalise ses seuils)
  └─► POST /save-org-preferences { danger_threshold: 35, ... }
        └─► transition auto → 'invested'

  (optionnel : connexion HubSpot)
  └─► POST /update-onboarding-step { step: 'hubspot' }

  (fin)
  └─► POST /update-onboarding-step { step: 'completed' }
```

---

---

## Comptes

### accounts-api (GET list / GET single / PATCH)

| | |
|---|---|
| **URL** | `.../functions/v1/accounts-api` |
| **Auth** | `Authorization: Bearer <jwt_utilisateur>` |

**GET** — Liste paginée

Query params : `limit` (1–100, défaut 50), `cursor` (UUID), `search` (texte libre sur display_name ou stripe_customer_id)

```json
{
  "data": [ /* Account[] */ ],
  "pagination": { "limit": 50, "next_cursor": "uuid | null", "has_more": false }
}
```

**GET** `?id=<uuid>` — Détail avec scores narratifs, insights et segments

```json
{
  "data": {
    "...account_fields": {},
    "display_name": "string | null",
    "scores": {
      "health":     { "value": 72, "narrative": "Fair health score (72/100). Some areas for improvement." },
      "usage":      { "value": 80, "narrative": "..." },
      "financial":  { "value": 65, "narrative": "..." },
      "engagement": { "value": 70, "narrative": "..." },
      "contract":   { "value": 60, "narrative": "..." },
      "churn_risk": { "value": 28 },
      "expansion":  { "value": 45 }
    },
    "insights": [ { "...insight_fields": {}, "is_new": true } ],
    "segments": [ { "segment_type": "stables", "priority": "normal", "added_at": "iso" } ],
    "hubspot": { "...hubspot_company_fields": {} }
  }
}
```

**PATCH** `?id=<uuid>` — Mise à jour du display_name (alias Sentio, jamais synchronisé)

Body : `{ "display_name": "string | null" }`  
Response 200 : `{ "data": { "id": "uuid", "display_name": "string | null" } }`

**Codes d'erreur** : `400`, `401`, `404`, `500`

`mrr_status` (Phase 5.5, `AUDIT_LOGIQUE_METIER_STRIPE.md` point 22) : `'ok' | 'unavailable'`, exposé sur `mrr_cents`/`account_fields` de la liste ET du détail — copie directe de `accounts.mrr_status` (`docs/openspec.md` §1/§8, "no data ≠ neutral data"). `'unavailable'` = compte non-chiffrable (metered, prix sans `unit_amount`, devise minoritaire) ou jamais eu de subscription connue (invoice-only, pas encore synchronisé) ; `mrr_cents` peut alors être un total partiel plutôt qu'un vrai `0` — le frontend doit afficher "Not billable" plutôt que le montant brut pour ces comptes.

---

### account-summary (GET)

Résumé IA en anglais des métriques d'un compte, généré par Claude Haiku et mis en cache 24h.

| | |
|---|---|
| **URL** | `.../functions/v1/account-summary?account_id=<uuid>` |
| **Méthode** | `GET` |
| **Auth** | `Authorization: Bearer <jwt_utilisateur>` |

**Response 200**
```json
{
  "summary": "This account shows a stable profile...",
  "generated_at": "2026-05-17T10:00:00Z",
  "cached": true
}
```

**Codes d'erreur**

| Code | Cas |
|------|-----|
| `400` | `account_id` manquant |
| `401` | JWT invalide |
| `404` | Compte introuvable |
| `503` | `ANTHROPIC_API_KEY` non configuré |

---

## Dashboard

### dashboard-api (GET)

Données agrégées pour la page "Aujourd'hui".

| | |
|---|---|
| **URL** | `.../functions/v1/dashboard-api/<route>` |
| **Auth** | `Authorization: Bearer <jwt_utilisateur>` |

**GET /briefing** — Briefing matinal

```json
{
  "data": {
    "portfolio": {
      "current_avg_health": 72.4,
      "week_ago_avg_health": 69.1,
      "health_delta_7d": 3.3,
      "health_trend": "up"
    },
    "risk_accounts_7d": 4,
    "p0_insights_count": 2,
    "insight_du_jour": {
      "account_id": "uuid",
      "stripe_customer_id": "cus_xxx",
      "display_name": "Acme Corp",
      "health_score_now": 42,
      "health_score_yesterday": 61,
      "delta": -19,
      "direction": "degraded",
      "main_dimension": "usage"
    },
    "billing_profile": "standard"
  }
}
```

`health_trend` : `"up" | "down" | "stable" | "unknown"`  
`insight_du_jour` : `null` si aucun compte n'a bougé significativement.
`billing_profile` (Phase 3, docs/openspec.md §11) : `"standard" | "needs_review" | null` — même champ/mêmes valeurs que `onboarding-status`, voir cette section pour le détail des signaux qui déclenchent `needs_review`.

**GET /wins** — Comptes améliorés sur les 7 derniers jours

```json
{
  "data": [
    {
      "account_id": "uuid",
      "stripe_customer_id": "cus_xxx",
      "display_name": "Beta SAS",
      "health_score_now": 78,
      "health_score_7d_ago": 54,
      "health_delta": 24,
      "main_dimension": "financial",
      "segment_before": "a_risque_leger",
      "segment_now": "stables",
      "segment_changed": true
    }
  ]
}
```

**GET /benchmarks** — NRR, churn et croissance MRR vs standards marché SaaS B2B

```json
{
  "data": {
    "nrr":       { "value": 105.2, "rating": "bon", "thresholds": { "excellent": 120, "bon": 105, "correct": 90 }, "higher_is_better": true, "sources": ["..."] },
    "churn_rate":{ "value": 4.5,   "rating": "bon", "thresholds": { "excellent": 3, "bon": 5, "correct": 10 },    "higher_is_better": false, "sources": ["..."] },
    "mrr_growth":{ "value": 32.1,  "rating": "excellent", "thresholds": { "excellent": 50, "bon": 25, "correct": 10 }, "higher_is_better": true, "sources": ["..."] },
    "peers": { "available": false, "min_orgs_required": 3 }
  }
}
```

`rating` : `"excellent" | "bon" | "correct" | "mediocre" | null`  
`peers.available: true` retourne les percentiles inter-orgs (p25/p50/p75) quand ≥ 3 orgs dans peer_benchmarks.

**Codes d'erreur** : `401`, `500`

**GET /portfolio-metrics** — Endpoint métriques autoritaire du portefeuille (Phase 4, docs/openspec.md)

Tous les champs sont précalculés côté serveur. **Le frontend ne doit jamais recalculer un total de portefeuille lui-même** (AUDIT_LOGIQUE_METIER_STRIPE.md point 22) — `useDashboardData`/`MrrDashboard`/`getAccountSummaryCards`/`fetchTopAccounts` consomment cet endpoint (Phase 5.2), leurs réimplémentations locales sont supprimées.

```json
{
  "data": {
    "mrr_cents": 1284500,
    "arr_cents": 15414000,
    "trial_mrr_cents": 49900,
    "nrr_percentage": 105.2,
    "churn_rate": 2.1,
    "accounts_at_risk": 4,
    "mrr_at_risk_cents": 98000,
    "expansion_opportunities": 3,
    "expansion_configured": true,
    "currency": "usd",
    "mrr_unavailable_accounts": 2,
    "billing_profile": "standard",
    "stripe_stale": false
  }
}
```

**Définitions exactes** (alimentent les tooltips frontend, Phase 5.4) :

| Champ | Définition |
|---|---|
| `mrr_cents` | Somme de `accounts.mrr_cents` sur l'org — déjà net des subscriptions non-chiffrables (`mrr_status='unavailable'`), déjà exclu des trials (docs/openspec.md §4), déjà net des remises actives (§2). |
| `arr_cents` | `mrr_cents × 12`. |
| `trial_mrr_cents` | Somme de `accounts.trial_mrr_cents` — MRR "en pipeline" des comptes en trial, jamais inclus dans `mrr_cents`. |
| `nrr_percentage` | Net Revenue Retention sur l'historique complet des `mrr_movements` de l'org (`movement_type != 'correction'`) : `(mrr_start + expansion + reactivation + contraction + churn) / mrr_start × 100` où `mrr_start = mrr_cents_actuel − mouvements_nets`. **`null`** si l'org a moins de 3 mois d'historique (premier `mrr_movements`, ou date de création de l'org si aucun mouvement) ou si `mrr_start ≤ 0`. Distinct du NRR de `GET /benchmarks` ci-dessus (fenêtre glissante 12 mois, calculé pour la comparaison inter-orgs anonymisée) — celui-ci est "où en est mon portefeuille maintenant", pas un chiffre de peer comparison. |
| `churn_rate` | % de MRR perdu sur les 30 derniers jours glissants : `\|churn_30j\| / mrr_début_fenêtre_30j × 100`. `null` si l'org a moins de 3 mois d'historique de `mrr_movements` (même garde que `nrr_percentage` — audit 2026-08-06, priorité 1 : avant ce correctif, `mrr_movements` totalement vide produisait `0.0%`, indiscernable d'un portefeuille réellement sans churn) ou si le MRR de début de fenêtre serait ≤ 0. |
| `accounts_at_risk` | Nombre de comptes `churn_risk_band = 'high'` OU `is_delinquent` (comptes `'churned'` déjà exclus par construction — D1 ; audit délinquence 2026-08-06, décision 3). |
| `mrr_at_risk_cents` | Somme de `mrr_cents` sur le sous-ensemble chiffrable (`mrr_status != 'unavailable'`) de ces comptes à risque — voir `accounts_at_risk_unpriced`. |
| `expansion_opportunities` | Nombre de comptes `expansion_score_status = 'available'` avec `expansion_score > 75`. |
| `expansion_configured` | `false` si aucun compte de l'org n'a `expansion_score_status = 'available'` (audit 2026-08-06, priorité 2) — signifie presque toujours que `stripe_product_mappings` n'a jamais été configuré pour cette org, pas qu'aucun compte n'a d'opportunité. |
| `currency` | Devise ISO 4217 de l'org (vote majoritaire sur les subscriptions, docs/openspec.md §9) — `null` si aucun sync n'a encore tourné. |
| `mrr_unavailable_accounts` | Nombre de comptes `mrr_status = 'unavailable'` (non-chiffrables : metered, prix sans `unit_amount`, devise minoritaire, invoice-only). |
| `billing_profile` | `"standard" \| "needs_review" \| null` — identique au champ du même nom sur `onboarding-status`. |
| `stripe_stale` | `true` si le dernier sync Stripe `completed` a plus de 48h, ou si aucun sync complet n'existe encore. |

**Codes d'erreur** : `401`, `500`

---

## Insights

### insights-crud (GET / PATCH)

| | |
|---|---|
| **URL** | `.../functions/v1/insights-crud` |
| **Auth** | `Authorization: Bearer <jwt_utilisateur>` |

**GET** — Liste dédupliquée avec filtres

Query params : `insight_type` (churn_prediction | expansion_opportunity | renewal_alert | payment_risk | usage_drop | account_health_summary, CSV), `priority` (low | medium | high | critical, CSV), `status` (active | acknowledged | resolved | dismissed, CSV, défaut `active`), `account_id`, `limit` (défaut 20, max 100), `offset` (défaut 0)

Tri fixe (non paramétrable) : `priority DESC` (critical d'abord) → `mrr_impact_cents DESC` → `created_at DESC`.

Déduplication : au plus 1 ligne par `(account_id, insight_type, created_at::date UTC)` — filet de sécurité en complément de l'index unique DB `idx_ai_insights_org_account_type_day`.

```json
{
  "insights": [ { "...insight_fields": {} } ],
  "total_count": 42,
  "critical_count": 3
}
```

`critical_count` = insights `active` + `priority=critical` de l'org, indépendant des filtres appliqués (alimente le badge de navigation).

**GET** `?id=<uuid>` — Détail d'un insight

**GET** `?stats=true` — Compteurs agrégés

```json
{
  "data": {
    "total": 12,
    "by_status":   { "active": 5, "acknowledged": 3, "resolved": 3, "dismissed": 1 },
    "by_priority": { "critical": 1, "high": 3, "medium": 6, "low": 2 },
    "by_type":     { "churn_prediction": 4, "payment_risk": 3, "...": 0 }
  }
}
```

**PATCH** `?id=<uuid>` — Transition de statut

Body : `{ "status": "acknowledged" | "resolved" | "dismissed" }`

Transitions autorisées : `active → acknowledged | resolved | dismissed`, `acknowledged → resolved | dismissed`. Les statuts `resolved` et `dismissed` sont terminaux.

**Codes d'erreur** : `400` (transition invalide), `401`, `404`, `409` (transition impossible), `500`

---

## Playbooks

### playbook-execute (POST)

Exécute un playbook manuellement sur des comptes ou un segment.

| | |
|---|---|
| **URL** | `.../functions/v1/playbook-execute` |
| **Méthode** | `POST` |
| **Auth** | `Authorization: Bearer <jwt_utilisateur>` |

**Body**
```json
{
  "playbook_id": "uuid",
  "account_ids": ["uuid"],
  "segment_id": "uuid",
  "execution_source": "manual",
  "cooldown_hours": 24
}
```

`account_ids` OU `segment_id` — au moins l'un. Max 200 comptes par run.  
`cooldown_hours` : ignore les comptes déjà exécutés dans ce délai (défaut : pas de cooldown).

**Action send_email**  
Requiert que l'organisation ait `notification_email` configuré dans la table `organizations`.
L'email est résolu en mémoire au moment de l'exécution, non stocké.
Si absent : action retourne `status: 'failed'` avec message explicite dans `playbook_executions.result`.

**Response 200**
```json
{ "executed": 3, "skipped": 1, "failed": 0 }
```

**Codes d'erreur** : `400`, `401`, `404` (playbook introuvable), `500`

---

### playbook-approve (PATCH)

Valide ou rejette un item de la file d'approbation CS.

| | |
|---|---|
| **URL** | `.../functions/v1/playbook-approve` |
| **Méthode** | `PATCH` |
| **Auth** | `Authorization: Bearer <jwt_utilisateur>` |

**Body**
```json
{
  "queue_item_id": "uuid",
  "action": "approved",
  "comment": "Approved after review"
}
```

`action` : `"approved" | "rejected"`. `comment` optionnel.

**Response 200**
```json
{ "success": true, "action": "approved", "connector_result": { "..." : "" } }
```

**Codes d'erreur**

| Code | Cas |
|------|-----|
| `400` | Payload invalide |
| `401` | JWT invalide |
| `404` | Item de queue introuvable |
| `409` | Item déjà traité |
| `410` | Item expiré |
| `500` | Erreur DB ou connecteur |

> Transit PII : si action = `approved`, l'email Stripe est récupéré depuis l'API en mémoire uniquement, jamais persisté.

---

### playbooks-suggested (GET)

Suggestion déterministe du playbook le plus pertinent à activer, basée sur l'état réel du portefeuille.

| | |
|---|---|
| **URL** | `.../functions/v1/playbooks-suggested` |
| **Méthode** | `GET` |
| **Auth** | `Authorization: Bearer <jwt_utilisateur>` |

**Priorité de suggestion** : `en_danger_critique → churn_prevention` > `impayes → payment_recovery` > `en_churn → winback` > `en_expansion → expansion` > `a_risque_leger → health_monitoring` > `renewal insights actifs → renewal`

**Response 200**
```json
{
  "data": {
    "suggested_playbook_id": "uuid | null",
    "template_category": "churn_prevention",
    "title": "Critical churn alert",
    "reason": "3 account(s) in critical danger identified in your portfolio.",
    "accounts_targeted": 3,
    "already_active": false,
    "segment_type": "en_danger_critique"
  }
}
```

`data` est `null` si aucune suggestion pertinente.

**Codes d'erreur** : `401`, `500`

---

### playbook-templates (GET)

Retourne la liste des templates de playbooks disponibles en V1.
Pas de filtre organization — les templates sont définis dans le code (constantes TypeScript).

| | |
|---|---|
| **URL** | `.../functions/v1/playbook-templates` |
| **Méthode** | `GET` |
| **Auth** | `Authorization: Bearer <jwt_utilisateur>` |

**Response 200**
```json
{
  "data": {
    "templates": [
      {
        "id": "churn-critical-alert",
        "title": "Critical churn alert",
        "description": "Sends an immediate email alert...",
        "playbook_type": "automated",
        "template_category": "churn_prevention",
        "priority": "critical",
        "is_automated": true,
        "trigger_conditions": { "health_score_below": 40, "evaluation": "daily" },
        "actions": [{ "type": "send_email", "order": 1, "config": { "email_subject": "...", "email_body_html": "..." } }]
      }
    ],
    "total": 6
  }
}
```

**Codes d'erreur** : `401` (JWT absent ou invalide), `405` (méthode non autorisée)

**Templates V1 disponibles** : `churn-critical-alert`, `churn-progressive-decline`, `renewal-upcoming`, `payment-recovery`, `expansion-opportunity`, `reactivation-churned`

**Utilisé par** : frontend modal "New playbook" — sélection de template

**Créer un playbook depuis un template** :
```
POST /playbook-crud { "from_template_id": "churn-critical-alert", "title": "My custom alert" }
→ 201 { "id": "uuid", "title": "My custom alert", "actions": [...], "organization_id": "..." }
```

---

### outbound-webhook-test (POST)

Envoie un payload de test vers une destination outbound configurée (sans attendre un vrai événement).

| | |
|---|---|
| **URL** | `.../functions/v1/outbound-webhook-test` |
| **Méthode** | `POST` |
| **Auth** | `Authorization: Bearer <jwt_utilisateur>` |

**Body**
```json
{
  "destination_id": "uuid"
}
```

**Response 200**
```json
{ "success": true, "status": 200, "response": "OK" }
```

**Codes d'erreur** : `400`, `401`, `404` (destination inconnue ou autre org), `500`

---

## Ops

### health-check (GET/POST)

Statut système global (DB, cron locks, syncs bloqués, DLQ). Appelable **sans authentification** (moniteur externe existant, `verify_jwt=false`) — un `Authorization: Bearer <jwt_utilisateur>` valide ajoute en plus les champs de fraîcheur de sync pour l'org résolue depuis ce JWT (Phase 3, docs/openspec.md).

| | |
|---|---|
| **URL** | `.../functions/v1/health-check` |
| **Méthode** | `GET` ou `POST` |
| **Auth** | Aucune (obligatoire) — JWT utilisateur optionnel pour les champs de fraîcheur |

**Response 200 (sans JWT)**
```json
{ "status": "ok", "checks": [...], "timestamp": "2026-08-04T12:00:00Z" }
```

**Response 200 (avec JWT utilisateur valide)**
```json
{
  "status": "ok",
  "checks": [...],
  "timestamp": "2026-08-04T12:00:00Z",
  "stripe_stale": false,
  "last_stripe_sync_hours_ago": 3.2,
  "hubspot_stale": true,
  "last_hubspot_sync_hours_ago": null
}
```

`*_stale` : `true` si le dernier sync `completed` de cette source a plus de 48h, ou si aucun sync `completed` n'existe encore pour cette org. `last_*_sync_hours_ago` : `null` si jamais synced, sinon un nombre (peut dépasser largement 48 si le sync est en panne depuis longtemps — jamais plafonné). `stripe_stale` reprend exactement le même contrat que `hubspot_stale` (déjà déclaré côté frontend, `src/types/ops.ts`, avant ce chantier — mais jamais réellement peuplé par le backend jusqu'ici).

**Codes d'erreur** : `500` (config serveur manquante), `503` (statut `unhealthy`)

---

## Session

### session-ping (POST)

Met à jour `last_seen_at` du profil courant. À appeler à chaque ouverture de session pour calculer les badges "nouveaux".

| | |
|---|---|
| **URL** | `.../functions/v1/session-ping` |
| **Méthode** | `POST` |
| **Auth** | `Authorization: Bearer <jwt_utilisateur>` |
| **Body** | `{}` (vide ou ignoré) |

**Response 200**
```json
{
  "data": {
    "last_seen_at": "2026-05-16T08:00:00Z",
    "current_seen_at": "2026-05-17T10:00:00Z",
    "new_insights_count": 3,
    "new_score_changes_count": 5
  }
}
```

`last_seen_at` = timestamp de la session précédente (avant ce ping). Le frontend utilise cette valeur pour afficher des badges sans refaire de requête.

`new_score_changes_count` : comptes dont `|health_score_now - health_score_at_last_seen| ≥ 5 pts`.

**Codes d'erreur** : `401`, `500`

---

## Ingestion d'usage

### track-usage (POST)

Ingère des événements d'usage produit depuis les systèmes du client (SDK, webhooks).

| | |
|---|---|
| **URL** | `.../functions/v1/track-usage` |
| **Méthode** | `POST` |
| **Auth** | `X-Sentio-Webhook-Secret: <secret>` — secret configuré dans Sentio (Intégrations → Usage Webhook) |

> Pas de JWT : cet endpoint est appelé depuis les systèmes produit du client, pas depuis le navigateur.

**Body**
```json
{
  "stripe_customer_id": "cus_xxx",
  "account_id": "uuid",
  "event_type": "login",
  "feature_name": "export",
  "event_count": 1,
  "event_date": "2026-05-17",
  "source": "api"
}
```

`stripe_customer_id` OU `account_id` — au moins l'un.  
`event_type` : `login | feature_used | api_call | export | report_viewed`  
`source` : `api | webhook | manual` (défaut : `api`)  
`event_date` : format `YYYY-MM-DD` (défaut : aujourd'hui)

**Response 201**
```json
{
  "success": true,
  "account_id": "uuid",
  "event_type": "login",
  "event_date": "2026-05-17",
  "event_count": 1
}
```

**Codes d'erreur**

| Code | Cas |
|------|-----|
| `400` | Payload invalide (event_type inconnu, event_count < 1, date invalide) |
| `401` | Header `X-Sentio-Webhook-Secret` absent ou secret invalide / inactif |
| `404` | Compte introuvable dans l'organisation |
| `500` | Erreur serveur |

---

## stripe-product-mappings-api

Gestion du mapping `stripe_price_id → plan_tier + seat_limit`.  
Chaque organisation configure ce mapping une fois via l'UI ; `sync-stripe` l'utilise à chaque run pour enrichir les comptes.

**Auth** : Bearer JWT utilisateur (ES256)

---

### GET `/stripe-product-mappings-api`

Retourne tous les mappings de l'organisation avec un flag `in_use`.

**Response 200**
```json
{
  "mappings": [
    {
      "id": "uuid",
      "organization_id": "uuid",
      "stripe_price_id": "price_xxx",
      "stripe_product_name": "Growth Plan",
      "stripe_price_label": "199€/mois",
      "plan_tier": "growth",
      "seat_limit": 25,
      "unlimited_seats": false,
      "in_use": true,
      "created_at": "2026-06-14T00:00:00Z",
      "updated_at": "2026-06-14T00:00:00Z"
    }
  ],
  "total": 1
}
```

`in_use: true` si ce `stripe_price_id` est actuellement utilisé dans un abonnement `active` ou `trialing` de l'organisation.

---

### PUT `/stripe-product-mappings-api`

Crée ou met à jour un mapping (upsert sur `organization_id + stripe_price_id`).

**Body**
```json
{
  "stripe_price_id": "price_xxx",
  "plan_tier": "growth",
  "seat_limit": 25,
  "unlimited_seats": false,
  "stripe_product_name": "Growth Plan",
  "stripe_price_label": "199€/mois"
}
```

| Champ | Type | Requis | Contraintes |
|-------|------|--------|-------------|
| `stripe_price_id` | `string` | Oui | Non vide |
| `plan_tier` | `'starter' \| 'growth' \| 'enterprise' \| null` | Non | null si non applicable |
| `seat_limit` | `number \| null` | Non | Entier > 0 ou null. Ignoré si `unlimited_seats = true` |
| `unlimited_seats` | `boolean` | Non | `true` = plan sans plafond ; force `seat_limit = null` |
| `stripe_product_name` | `string \| null` | Non | Label d'identification dans l'UI |
| `stripe_price_label` | `string \| null` | Non | Ex : `"199€/mois"`, affiché dans l'UI |

**Response 200**
```json
{
  "mapping": {
    "id": "uuid",
    "organization_id": "uuid",
    "stripe_price_id": "price_xxx",
    "stripe_product_name": "Growth Plan",
    "stripe_price_label": "199€/mois",
    "plan_tier": "growth",
    "seat_limit": 25,
    "unlimited_seats": false,
    "created_at": "2026-06-14T00:00:00Z",
    "updated_at": "2026-06-14T00:00:00Z"
  }
}
```

**Codes d'erreur**

| Code | Cas |
|------|-----|
| `400` | `stripe_price_id` absent ou vide |
| `400` | `plan_tier` hors des valeurs autorisées |
| `400` | `seat_limit` non entier ou ≤ 0 |
| `500` | Erreur DB |

---

### GET `/stripe-product-mappings-api/prices-from-stripe`

Appelle l'API Stripe de l'organisation pour lister tous les prices récurrents actifs.  
Sert à pré-peupler l'UI de configuration du mapping.

**Response 200**
```json
{
  "prices": [
    {
      "stripe_price_id": "price_xxx",
      "stripe_product_name": "Growth Plan",
      "stripe_price_label": "199€/mois",
      "currency": "eur",
      "unit_amount": 19900,
      "recurring_interval": "month",
      "already_mapped": true
    }
  ]
}
```

`already_mapped: true` si ce `stripe_price_id` a déjà un mapping configuré pour cette organisation.  
Les prices non-récurrents (one-shot) sont exclus de la réponse.

**Codes d'erreur**

| Code | Cas |
|------|-----|
| `400` | Clé Stripe non configurée pour l'organisation |
| `502` | Erreur ou timeout lors de l'appel Stripe |

---

### Type `StripeProductMapping`

```typescript
interface StripeProductMapping {
  id: string
  organization_id: string
  stripe_price_id: string
  stripe_product_name: string | null
  stripe_price_label: string | null
  plan_tier: 'starter' | 'growth' | 'enterprise' | null
  seat_limit: number | null          // null = non configuré (≠ illimité)
  unlimited_seats: boolean           // true = plan sans plafond de sièges
  in_use?: boolean                   // présent uniquement dans GET liste
  created_at: string
  updated_at: string
}
```

> **Règle `seat_limit`** : `null` signifie "non configuré". Ce n'est pas la même chose qu'illimité.  
> Un plan illimité est représenté par `unlimited_seats: true` + `seat_limit: null`.  
> `sync-stripe` utilise `seat_limit = null` comme signal d'absence de mapping → `expansion_score` calculé en mode absolu (`seat_count / 15`).

---

## Headers requis sur tous les appels

```
Authorization: Bearer <supabase_access_token>
Content-Type: application/json
```

> Exception : `track-usage` utilise `X-Sentio-Webhook-Secret` à la place de `Authorization`.
