# Prompt : Écran "Insights IA" — Frontend V1

## Contexte

Le backend AI Insights est maintenant opérationnel. Il génère quotidiennement des insights basés sur les scores de santé client et expose une API REST complète. Ce prompt décrit l'implémentation frontend pour consommer cette API.

## API Backend disponible

### Base URL
```
${NEXT_PUBLIC_SUPABASE_URL}/functions/v1/insights-crud
```

### Authentification
Header `Authorization: Bearer <jwt_utilisateur>` (token Supabase Auth standard).

### Endpoints

#### 1. Liste paginée
```
GET /functions/v1/insights-crud
```

**Query params :**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `insight_type` | string (csv) | — | Filtre par type(s) : `churn_prediction`, `expansion_opportunity`, `renewal_alert`, `payment_risk`, `usage_drop` |
| `priority` | string (csv) | — | Filtre par priorité(s) : `low`, `medium`, `high`, `critical` |
| `status` | string (csv) | `active` | Filtre par statut(s) : `active`, `acknowledged`, `resolved`, `dismissed` |
| `account_id` | uuid | — | Insights d'un compte spécifique |
| `sort` | string | `created_at` | Tri : `created_at`, `priority`, `confidence_score`, `mrr_impact_cents` |
| `page` | number | `1` | Page |
| `per_page` | number | `20` | Résultats par page (max 100) |

**Réponse :**
```json
{
  "data": [
    {
      "id": "uuid",
      "organization_id": "uuid",
      "account_id": "uuid",
      "insight_type": "churn_prediction",
      "title": "Risque de churn critique détecté",
      "description": "Ce compte présente un risque de churn de 85% avec un score de santé de 25%. MRR à risque : 1 500 €.",
      "recommended_action": "Intervention immédiate du CSM requise. Planifier un appel de rétention dans les 48h.",
      "priority": "critical",
      "confidence_score": 85.00,
      "mrr_impact_cents": 150000,
      "status": "active",
      "source_scores": { "churn_risk_score": 85, "health_score": 25 },
      "ai_model_version": "rules-v1",
      "acknowledged_at": null,
      "acknowledged_by": null,
      "resolved_at": null,
      "dismissed_at": null,
      "created_at": "2026-03-05T10:00:00Z",
      "updated_at": "2026-03-05T10:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "per_page": 20,
    "total": 42,
    "total_pages": 3
  }
}
```

#### 2. Détail d'un insight
```
GET /functions/v1/insights-crud?id=<uuid>
```

**Réponse :**
```json
{
  "data": { /* même structure que ci-dessus */ }
}
```

#### 3. Statistiques agrégées
```
GET /functions/v1/insights-crud?stats=true
```

**Réponse :**
```json
{
  "data": {
    "total": 42,
    "total_mrr_impact_cents": 3500000,
    "by_type": {
      "churn_prediction": 12,
      "expansion_opportunity": 8,
      "payment_risk": 5,
      "renewal_alert": 10,
      "usage_drop": 7
    },
    "by_priority": {
      "critical": 6,
      "high": 15,
      "medium": 18,
      "low": 3
    },
    "by_status": {
      "active": 35,
      "acknowledged": 7
    }
  }
}
```

#### 4. Transition de statut
```
PATCH /functions/v1/insights-crud?id=<uuid>
Content-Type: application/json

{ "status": "acknowledged" }
```

**Transitions autorisées :**
- `active` → `acknowledged`, `resolved`, `dismissed`
- `acknowledged` → `resolved`, `dismissed`
- `resolved` / `dismissed` → aucune transition (états terminaux)

**Réponse :** `{ "data": { /* insight mis à jour */ } }`

**Erreur transition invalide :** `422 { "error": "Cannot transition from 'resolved' to 'active'. Allowed: none" }`

---

## Spécification Frontend

### Page principale : `/dashboard/insights`

#### Layout
```
┌─────────────────────────────────────────────────────────────┐
│  Insights IA                                    [Filtres ▼] │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ 42       │ │ 6        │ │ 35 000 € │ │ 8        │       │
│  │ Total    │ │ Critiques│ │ MRR à    │ │ Expansion│       │
│  │ insights │ │          │ │ risque   │ │ potentiel│       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
├─────────────────────────────────────────────────────────────┤
│  [Tous] [Churn] [Expansion] [Renouvellement] [Paiement]    │
│  [Usage]                                                     │
│                                                              │
│  Status: [Actifs] [Reconnus] [Résolus] [Rejetés]            │
│  Tri: [Date ▼] [Priorité] [Confiance] [Impact MRR]         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─ 🔴 CRITIQUE ──────────────────────────────────────────┐ │
│  │ Risque de churn critique détecté                        │ │
│  │ Ce compte présente un risque de churn de 85%...         │ │
│  │ MRR à risque : 1 500 €  •  Confiance : 85%             │ │
│  │ Il y a 2h  •  Compte: ACC-123                           │ │
│  │                                                          │ │
│  │ Action recommandée :                                     │ │
│  │ Intervention immédiate du CSM requise...                 │ │
│  │                                                          │ │
│  │ [✓ Reconnaître] [✗ Rejeter] [→ Voir le compte]         │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ 🟡 MEDIUM ────────────────────────────────────────────┐ │
│  │ Opportunité d'expansion détectée                        │ │
│  │ ...                                                      │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                              │
│  ← Page 1/3 →                                               │
└─────────────────────────────────────────────────────────────┘
```

### Composants à créer

#### 1. `InsightsPage` (`src/app/dashboard/insights/page.tsx`)
- Page principale avec Suspense boundary
- Charge les stats (endpoint `?stats=true`) pour les KPI cards
- Charge la liste paginée avec les filtres actifs
- Gère l'état des filtres via `useSearchParams`

#### 2. `InsightStatsCards` (`src/components/insights/InsightStatsCards.tsx`)
- 4 cartes KPI en haut :
  - Total insights actifs
  - Nombre de critiques (badge rouge)
  - MRR total à risque (en euros, formaté)
  - Opportunités d'expansion (count)

#### 3. `InsightFilters` (`src/components/insights/InsightFilters.tsx`)
- Filtres par type (tabs ou chips) : Tous, Churn, Expansion, Renouvellement, Paiement, Usage
- Filtres par statut : Actifs (default), Reconnus, Résolus, Rejetés
- Tri : Date (default), Priorité, Confiance, Impact MRR

#### 4. `InsightCard` (`src/components/insights/InsightCard.tsx`)
- Carte d'insight avec :
  - Badge de priorité coloré (critical=rouge, high=orange, medium=jaune, low=gris)
  - Badge de type (icône + label)
  - Titre + description
  - MRR impact (formaté en euros) + confidence score (%)
  - Date relative ("il y a 2h", "hier")
  - Lien vers le compte (`/dashboard/accounts/{account_id}`)
  - Section "Action recommandée" pliable
  - Boutons d'action : Reconnaître, Rejeter, Voir le compte

#### 5. `InsightActions` (`src/components/insights/InsightActions.tsx`)
- Boutons pour les transitions de statut
- Appel PATCH vers l'API
- Optimistic UI (mise à jour immédiate, rollback on error)
- Confirmation pour "Rejeter" (dismissed est terminal)

#### 6. `InsightsPagination` (`src/components/insights/InsightsPagination.tsx`)
- Navigation entre pages
- Affichage "Page X/Y — Z résultats"

### Intégration dans le dashboard existant

#### Navigation
- Ajouter un lien "Insights IA" dans la sidebar/nav du dashboard
- Badge avec le nombre d'insights actifs critiques

#### Page compte (`/dashboard/accounts/[id]`)
- Ajouter une section "Insights" dans le détail du compte
- Utiliser le filtre `?account_id=<id>` pour charger les insights du compte
- Afficher les 5 derniers insights (tous statuts)

### Mapping des types d'insights

| Type API | Label FR | Icône | Couleur |
|----------|----------|-------|---------|
| `churn_prediction` | Risque de churn | ⚠️ ou AlertTriangle | Rouge |
| `expansion_opportunity` | Expansion | 📈 ou TrendingUp | Vert |
| `renewal_alert` | Renouvellement | 📅 ou Calendar | Orange |
| `payment_risk` | Paiement | 💳 ou CreditCard | Rouge |
| `usage_drop` | Baisse d'usage | 📉 ou TrendingDown | Jaune |

### Mapping des priorités

| Priority | Label FR | Couleur badge | Ordre |
|----------|----------|---------------|-------|
| `critical` | Critique | `bg-red-100 text-red-800` | 1 |
| `high` | Élevée | `bg-orange-100 text-orange-800` | 2 |
| `medium` | Moyenne | `bg-yellow-100 text-yellow-800` | 3 |
| `low` | Faible | `bg-gray-100 text-gray-600` | 4 |

### Mapping des statuts

| Status | Label FR | Badge |
|--------|----------|-------|
| `active` | Actif | `bg-blue-100 text-blue-800` |
| `acknowledged` | Reconnu | `bg-purple-100 text-purple-800` |
| `resolved` | Résolu | `bg-green-100 text-green-800` |
| `dismissed` | Rejeté | `bg-gray-100 text-gray-500` |

### Hooks à créer

#### `useInsights` (`src/hooks/useInsights.ts`)
```typescript
interface UseInsightsOptions {
  insightType?: string
  priority?: string
  status?: string
  accountId?: string
  sort?: string
  page?: number
  perPage?: number
}

interface UseInsightsReturn {
  insights: Insight[]
  pagination: Pagination
  isLoading: boolean
  error: string | null
  refetch: () => void
}
```

#### `useInsightStats` (`src/hooks/useInsightStats.ts`)
```typescript
interface InsightStats {
  total: number
  total_mrr_impact_cents: number
  by_type: Record<string, number>
  by_priority: Record<string, number>
  by_status: Record<string, number>
}
```

#### `useInsightActions` (`src/hooks/useInsightActions.ts`)
```typescript
interface UseInsightActionsReturn {
  acknowledge: (id: string) => Promise<void>
  resolve: (id: string) => Promise<void>
  dismiss: (id: string) => Promise<void>
  isUpdating: boolean
}
```

### Types à créer (`src/types/insights.ts`)

```typescript
export type InsightType = 'churn_prediction' | 'expansion_opportunity' | 'renewal_alert' | 'payment_risk' | 'usage_drop'
export type InsightPriority = 'low' | 'medium' | 'high' | 'critical'
export type InsightStatus = 'active' | 'acknowledged' | 'resolved' | 'dismissed'

export interface Insight {
  id: string
  organization_id: string
  account_id: string | null
  insight_type: InsightType
  title: string
  description: string
  recommended_action: string | null
  priority: InsightPriority
  confidence_score: number | null
  mrr_impact_cents: number | null
  status: InsightStatus
  source_scores: Record<string, number> | null
  ai_model_version: string | null
  acknowledged_at: string | null
  acknowledged_by: string | null
  resolved_at: string | null
  dismissed_at: string | null
  created_at: string
  updated_at: string
}
```

### Appels API — Pattern Supabase Functions

```typescript
// Utiliser le client Supabase existant
const supabase = createBrowserClient(...)

// Liste paginée
const { data, error } = await supabase.functions.invoke('insights-crud', {
  method: 'GET',
  // Note: supabase.functions.invoke ne supporte pas les query params nativement
  // → Utiliser fetch directement avec le token
})

// Alternative recommandée : fetch direct
const response = await fetch(
  `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/insights-crud?status=active&sort=priority&page=1&per_page=20`,
  {
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
  }
)
```

### Formatage

- **MRR** : `(mrr_impact_cents / 100).toLocaleString('fr-FR')` + ` €`
- **Dates** : format relatif ("il y a 2h", "hier", "il y a 3 jours") avec `Intl.RelativeTimeFormat('fr')`
- **Confidence** : `{confidence_score}%` avec barre de progression visuelle
- **Textes** : tout est déjà en français côté backend (titles, descriptions, recommended_action)

### Responsive

- Desktop : grille 4 colonnes pour les KPI cards, liste d'insights pleine largeur
- Tablet : grille 2 colonnes pour les KPI cards
- Mobile : stack vertical, insights en cards pleine largeur, filtres en dropdown

### Empty states

- Aucun insight actif : "Aucun insight détecté — vos comptes sont en bonne santé ✓"
- Filtre sans résultat : "Aucun insight ne correspond aux filtres sélectionnés"
- Erreur API : "Impossible de charger les insights. Réessayer." + bouton retry

### Performance

- Utiliser `useSWR` ou `React Query` si disponible dans le projet, sinon `useEffect` + `useState`
- Debounce les changements de filtres (300ms)
- Skeleton loading sur les cards pendant le chargement
- Pas de requête si le composant n'est pas visible (Intersection Observer optionnel)

---

## Checklist d'implémentation

1. [ ] Créer les types TypeScript (`src/types/insights.ts`)
2. [ ] Créer les hooks API (`src/hooks/useInsights.ts`, `useInsightStats.ts`, `useInsightActions.ts`)
3. [ ] Créer le composant `InsightStatsCards`
4. [ ] Créer le composant `InsightFilters`
5. [ ] Créer le composant `InsightCard` avec actions
6. [ ] Créer la page `/dashboard/insights/page.tsx`
7. [ ] Ajouter la navigation dans la sidebar
8. [ ] Ajouter la section insights dans la page détail compte
9. [ ] Tester les transitions de statut (acknowledge, resolve, dismiss)
10. [ ] Vérifier le responsive (mobile, tablet, desktop)
