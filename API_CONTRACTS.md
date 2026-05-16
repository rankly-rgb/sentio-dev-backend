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
  "company_name": "Acme Corp",
  "locale": "fr"
}
```

> `locale` est optionnel — défaut `'fr'`. Valeurs acceptées : `'fr'` | `'en'`.


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
  "segment_name_at_risk": "À risque léger",
  "segment_name_danger": "En danger",
  "segment_name_stable": "Stables",
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

## Locale organisation

### get-organization-locale

Retourne la locale de l'organisation appelante. À appeler au chargement de l'app pour hydrater le contexte locale frontend.

| | |
|---|---|
| **URL** | `https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/get-organization-locale` |
| **Méthode** | `GET` |
| **Auth** | `Authorization: Bearer <jwt_utilisateur>` |

**Response 200**
```json
{ "locale": "fr" }
```

**Codes d'erreur** : `401`, `404`, `500`

---

### update-organization-locale

Met à jour la locale de l'organisation. Valeurs acceptées : `'fr'` | `'en'`.

| | |
|---|---|
| **URL** | `https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/update-organization-locale` |
| **Méthode** | `PATCH` |
| **Auth** | `Authorization: Bearer <jwt_utilisateur>` |

**Body**
```json
{ "locale": "en" }
```

**Response 200**
```json
{ "success": true, "locale": "en" }
```

**Codes d'erreur**

| Code | Cas |
|------|-----|
| `400` | `locale` manquant ou valeur hors `['fr', 'en']` |
| `401` | JWT absent ou invalide |
| `500` | Erreur base de données |

---

### org-settings (GET/PATCH)

Paramètres complets de l'organisation. Le GET retourne la locale **et** le dictionnaire de traductions complet, ce qui permet au frontend de charger toutes les chaînes en une seule requête.

| | |
|---|---|
| **URL** | `https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/org-settings` |
| **GET** | Retourne `{ data: { locale: 'fr' \| 'en', translations: Record<string, string> } }` |
| **PATCH body** | `{ locale: 'fr' \| 'en' }` → Response `{ success: true }` |

---

## Fonctions existantes (inchangées)

### onboarding-status (GET/PATCH)

État technique de l'onboarding (sync Stripe, scoring).
Complémentaire à `get-onboarding-status-v2`.

| | |
|---|---|
| **URL** | `https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/onboarding-status` |
| **GET** | Retourne `stripe_connected`, `stripe_sync_in_progress`, `first_score_calculated`, `current_step`, `at_risk_count` |
| **PATCH** | `{ field: 'first_win_seen' \| 'onboarding_completed', value: true }` |

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

## Headers requis sur tous les appels

```
Authorization: Bearer <supabase_access_token>
Content-Type: application/json
```
