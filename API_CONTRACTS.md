# API Contracts — Session Backend 7 Chantiers UX

> Source de vérité pour la session frontend qui suit.
> Générée le 2026-04-19. Tous les endpoints utilisent `Authorization: Bearer <JWT>`.
> Base URL : `https://<project>.supabase.co/functions/v1`

---

## Auth — pattern commun

Tous les endpoints marqués **Auth: JWT** attendent :

```
Authorization: Bearer <supabase_access_token>
```

L'`organization_id` est résolu côté serveur depuis le JWT — ne jamais le passer en body.

Codes d'erreur communs :

| Code | Cause |
|------|-------|
| 401  | Token manquant, expiré ou invalide |
| 403  | Utilisateur sans organisation |
| 405  | Méthode non supportée |
| 500  | Erreur serveur |

---

## Chantier 1 — Alias des comptes

### `GET /accounts-api`

Liste paginée des comptes avec leur alias.

**Query params**

| Param | Type | Défaut | Description |
|-------|------|--------|-------------|
| `limit` | number | 50 | 1–100 |
| `cursor` | string (ISO date) | — | Pagination curseur (`created_at` du dernier item) |
| `search` | string | — | Recherche sur `display_name` ou `stripe_customer_id` (ilike) |

**Response 200**

```typescript
{
  data: Array<{
    id: string
    stripe_customer_id: string
    display_name: string | null       // alias métier Sentio
    plan_tier: "starter" | "growth" | "enterprise" | null
    billing_interval: "monthly" | "annual" | null
    mrr_cents: number
    health_score: number | null
    churn_risk_score: number | null
    expansion_score: number | null
    product_usage_score: number | null
    financial_score: number | null
    engagement_score: number | null
    contract_score: number | null
    contract_end_date: string | null  // YYYY-MM-DD
    scores_calculated_at: string | null
    created_at: string
    updated_at: string
  }>
  pagination: {
    limit: number
    next_cursor: string | null        // valeur à passer comme cursor pour la page suivante
    has_more: boolean
  }
}
```

---

### `GET /accounts-api?id=:uuid`

Détail d'un compte avec scores narratifs et insights.

**Response 200**

```typescript
{
  data: {
    id: string
    organization_id: string
    stripe_customer_id: string
    hubspot_company_id: string | null
    display_name: string | null
    plan_tier: string | null
    billing_interval: string | null
    mrr_cents: number
    arr_cents: number
    seat_count: number
    seat_limit: number | null
    contract_start_date: string | null
    contract_end_date: string | null
    scores_calculated_at: string | null
    created_at: string
    updated_at: string

    scores: {
      health:     { value: number | null; narrative: string }
      usage:      { value: number | null; narrative: string }
      financial:  { value: number | null; narrative: string }
      engagement: { value: number | null; narrative: string }
      contract:   { value: number | null; narrative: string }
      churn_risk: { value: number | null }
      expansion:  { value: number | null }
    }

    insights: Array<{
      id: string
      insight_type: "churn_prediction" | "expansion_opportunity" | "renewal_alert" | "payment_risk" | "usage_drop"
      title: string
      description: string
      recommended_action: string | null
      priority: "low" | "medium" | "high" | "critical"
      confidence_score: number | null
      mrr_impact_cents: number | null
      status: "active" | "acknowledged" | "resolved" | "dismissed"
      created_at: string
      is_new: boolean     // true si créé après le dernier last_seen_at de l'utilisateur
    }>

    segments: Array<{
      segment_type: string | null
      priority: string | null
      added_at: string
      risk_score: number | null
    }>

    hubspot: {
      lifecycle_stage: string | null
      nps_score: number | null
      open_deal_count: number | null
      open_ticket_count: number | null
      last_meeting_date: string | null
      last_email_date: string | null
    } | null
  }
}
```

**Response 404** `{ "error": "Account not found" }`

---

### `PATCH /accounts-api?id=:uuid`

Met à jour l'alias métier d'un compte.

> Contrainte : `display_name` est une donnée Sentio pure — jamais synchronisée depuis Stripe ou HubSpot.

**Body**

```typescript
{
  display_name: string | null   // null pour supprimer l'alias. Max 200 caractères.
}
```

**Response 200**

```typescript
{
  data: {
    id: string
    display_name: string | null
  }
}
```

**Erreurs**

| Code | Message |
|------|---------|
| 400  | `display_name field is required` |
| 400  | `display_name must be a non-empty string or null` |
| 400  | `display_name must not exceed 200 characters` |
| 404  | `Account not found` |

---

## Chantier 2 — Onboarding & Aha Moment

### `GET /onboarding-status`

État d'onboarding de l'organisation.

**Response 200**

```typescript
{
  data: {
    stripe_connected: boolean          // ≥1 sync Stripe complété
    hubspot_connected: boolean         // ≥1 sync HubSpot complété
    first_score_calculated: boolean    // ≥1 score calculé pour l'org
    aha_moment_ready: boolean          // stripe_connected AND first_score_calculated
    aha_moment_seen: boolean           // aha moment déjà affiché à l'utilisateur
    first_score_calculated_at: string | null
    aha_moment_seen_at: string | null
    accounts_count: number

    // Présent uniquement si aha_moment_ready=true et aha_moment_seen=false
    top_risk_account: {
      id: string
      stripe_customer_id: string
      display_name: string | null
      churn_risk_score: number
      health_score: number
    } | null
  }
}
```

**Logique d'affichage recommandée (frontend)**

```
if (aha_moment_ready && !aha_moment_seen && top_risk_account) {
  // Afficher le moment de révélation avec top_risk_account
  // Puis appeler POST /onboarding-status/aha-seen
}
```

---

### `POST /onboarding-status/aha-seen`

Marque le aha moment comme vu (idempotent).

**Body** `{}` (vide)

**Response 200**

```typescript
{
  data: {
    aha_moment_seen_at: string   // ISO timestamp
  }
}
```

---

## Chantier 3 — Briefing "Aujourd'hui"

### `GET /dashboard-api/briefing`

Données pour le briefing matinal.

**Response 200**

```typescript
{
  data: {
    portfolio: {
      current_avg_health: number | null    // moyenne health score aujourd'hui (arrondi 1 décimale)
      week_ago_avg_health: number | null   // moyenne health score J-7
      health_delta_7d: number | null       // delta en points (positif = amélioration)
      health_trend: "up" | "down" | "stable" | "unknown"
                                           // up: delta > 1pt; down: delta < -1pt; stable sinon
    }
    risk_accounts_7d: number      // comptes entrés dans un segment risqué sur 7 jours
                                  // segments risqués : en_danger_critique, a_risque_leger,
                                  //                   en_churn, impayes
    p0_insights_count: number     // insights actifs priorité "critical"

    insight_du_jour: {            // compte avec la plus grande variation de score en 24h
      account_id: string
      stripe_customer_id: string
      display_name: string | null
      health_score_now: number
      health_score_yesterday: number
      delta: number               // positif = amélioration (arrondi 1 décimale)
      direction: "improved" | "degraded"
      main_dimension: "usage" | "financial" | "engagement" | "contract"
    } | null                      // null si pas de snapshot J-1 disponible
  }
}
```

---

## Chantier 4 — Wins de la semaine

### `GET /dashboard-api/wins`

Comptes ayant le plus progressé sur 7 jours.

**Définition d'un "win"** : health_score amélioré d'au moins **10 points** en 7 jours, avec health_score actuel **≥ 50**. Maximum 5 wins retournés, triés par delta décroissant.

**Response 200**

```typescript
{
  data: Array<{
    account_id: string
    stripe_customer_id: string
    display_name: string | null
    health_score_now: number
    health_score_7d_ago: number
    health_delta: number              // toujours >= 10 (arrondi 1 décimale)
    main_dimension: "usage" | "financial" | "engagement" | "contract"
                                      // dimension ayant le plus progressé
    segment_before: string | null     // segment il y a 7 jours
    segment_now: string | null        // segment actuel
    segment_changed: boolean
  }>
}
```

> Si `data` est vide : aucun win cette semaine (afficher un message neutre, pas d'erreur).

---

## Chantier 5 — Narratives de score de santé

Intégré dans `GET /accounts-api?id=:uuid` (voir Chantier 1).

Le champ `scores` de la réponse contient pour chaque dimension un objet `{ value, narrative }`.

**Exemples de narratives générées**

| Dimension | Score | Narrative exemple |
|-----------|-------|-------------------|
| financial | 95 | "Aucun impayé, abonnement actif depuis 18 mois. MRR : 490 €." |
| financial | 35 | "Risque financier élevé : 3 impayé(s) pour 1 200 € au total." |
| usage | 85 | "Utilisation active : 2 340 événements sur les 30 derniers jours." |
| usage | 50 | "Aucune donnée d'utilisation disponible." |
| engagement | 75 | "Bon engagement, dernière réunion il y a 3 jour(s)." |
| engagement | 30 | "Faible engagement : 4 ticket(s) ouvert(s), aucune réunion récente." |
| contract | — | "Renouvellement critique : dans 12 jour(s) (2026-05-01)." |
| contract | — | "Contrat actif, renouvellement dans 180 jours (2026-10-16)." |
| health | 87 | "Score de santé excellent (87/100)." |
| health | 32 | "Score de santé critique (32/100). Intervention urgente recommandée." |

Les narratives sont déterministes, en français, sans IA générative.

---

## Chantier 6 — Playbook suggéré automatiquement

### `GET /playbooks-suggested`

Retourne le playbook le plus pertinent à activer en ce moment.

**Règles de priorité** (ordre décroissant, première règle satisfaite gagne) :

| Priorité | Condition | Catégorie suggérée |
|----------|-----------|-------------------|
| 1 | Segment `en_danger_critique` a ≥ 1 compte | `churn_prevention` |
| 2 | Segment `impayes` a ≥ 1 compte | `payment_recovery` |
| 3 | Segment `en_churn` a ≥ 1 compte | `winback` |
| 4 | Segment `en_expansion` a ≥ 1 compte | `expansion` |
| 5 | Segment `a_risque_leger` a ≥ 3 comptes | `health_monitoring` |
| 6 | ≥ 1 insight `renewal_alert` actif | `renewal` |

**Response 200 — suggestion trouvée**

```typescript
{
  data: {
    suggested_playbook_id: string | null   // ID du playbook existant si déjà créé
    template_category: string              // catégorie suggérée
    title: string                          // titre du playbook existant ou titre suggéré
    reason: string                         // ex: "3 comptes en danger critique identifiés."
    accounts_targeted: number              // nb de comptes ciblés si activé
    already_active: boolean                // un playbook de cette catégorie est déjà actif
    segment_type: string | null            // segment source de la suggestion
  }
}
```

**Response 200 — aucune suggestion**

```typescript
{
  data: null
}
```

**Comportement frontend recommandé**

```
if (data === null) {
  // "Votre portefeuille est en bonne santé — aucun playbook urgent à activer."
}
if (data && data.already_active) {
  // "Le playbook [title] est déjà actif."
} else if (data) {
  // CTA : "Activer [title]" → POST /playbook-execute
}
```

---

## Chantier 7 — Session tracking & is_new

### `POST /session-ping`

À appeler à chaque ouverture de session (page load ou focus de fenêtre).
Met à jour `last_seen_at` de l'utilisateur et retourne les compteurs de nouveautés.

**Body** `{}` (vide)

**Response 200**

```typescript
{
  data: {
    last_seen_at: string | null         // timestamp de la SESSION PRÉCÉDENTE (avant ce ping)
                                        // null si première visite
    current_seen_at: string             // timestamp mis à jour maintenant
    new_insights_count: number          // insights actifs créés depuis last_seen_at
    new_score_changes_count: number     // comptes dont le health_score a bougé de ≥ 5pts
  }
}
```

**Fréquence d'appel recommandée** : une seule fois par session (au mount du root layout), avec debounce de 60 secondes si re-focus.

---

### Champ `is_new` sur les insights

Le champ `is_new: boolean` est présent dans la réponse de `GET /accounts-api?id=:uuid` pour chaque insight.

**Calcul** : `is_new = insight.created_at > user.last_seen_at`

Si `last_seen_at` est null (première visite) : `is_new = false`.

---

### Mise à jour du contrat `GET /onboarding-status/insights-crud`

L'endpoint `GET /insights-crud` existant peut être enrichi côté frontend en croisant `created_at` de chaque insight avec le `last_seen_at` retourné par `POST /session-ping`.

Pattern recommandé (frontend) :

```typescript
// 1. Au mount : récupérer last_seen_at
const { data: ping } = await fetch('/session-ping', { method: 'POST' }).json()
const lastSeenAt = ping.last_seen_at

// 2. Sur chaque insight : calculer is_new
const isNew = lastSeenAt ? new Date(insight.created_at) > new Date(lastSeenAt) : false
```

---

## Résumé des endpoints produits

| Endpoint | Méthode | Chantier | Fonction |
|----------|---------|----------|----------|
| `/accounts-api` | GET | 1 | Liste comptes + display_name |
| `/accounts-api?id=:uuid` | GET | 1, 5, 7 | Détail + narratives + is_new |
| `/accounts-api?id=:uuid` | PATCH | 1 | Mise à jour display_name |
| `/onboarding-status` | GET | 2 | État onboarding + top_risk_account |
| `/onboarding-status/aha-seen` | POST | 2 | Marquer aha moment vu |
| `/dashboard-api/briefing` | GET | 3 | Briefing matinal agrégé |
| `/dashboard-api/wins` | GET | 4 | Wins de la semaine |
| `/playbooks-suggested` | GET | 6 | Suggestion déterministe de playbook |
| `/session-ping` | POST | 7 | Mise à jour last_seen_at + compteurs nouveautés |

## Migrations SQL associées

| Fichier | Contenu |
|---------|---------|
| `20260419000001_chantier1_display_name.sql` | `accounts.display_name TEXT NULL` + index |
| `20260419000002_chantier2_onboarding.sql` | `organizations.aha_moment_seen_at`, `organizations.first_score_calculated_at` |
| `20260419000007_chantier7_session_tracking.sql` | `profiles_.last_seen_at TIMESTAMPTZ NULL` + index |
