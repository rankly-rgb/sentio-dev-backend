# Prompt Frontend — Insights IA V2 : Boutons Reconnaître/Rejeter + Fixes

## Contexte

La page Insights IA (`/dashboard/insights`) est actuellement en SSR pur et read-only. Les boutons "Reconnaître" et "Rejeter" ne sont pas connectes au backend. Le backend PATCH est pourtant **production-ready** depuis l'Insights Backend v1.

Ce prompt consolide les fixes (noms de colonnes) et ajoute l'interactivite (transitions de statut).

---

## Problemes actuels

### 1. Noms de colonnes incorrects dans la query Supabase

```ts
// INCORRECT (page.tsx actuel)
.select('id, type, title, ..., impact_mrr_cents, ...')

// CORRECT (schema DB)
.select('id, insight_type, title, ..., mrr_impact_cents, ...')
```

| Incorrect (frontend) | Correct (DB) |
|---|---|
| `type` | `insight_type` |
| `impact_mrr_cents` | `mrr_impact_cents` |

**Consequence** : `insight.type` est `undefined`, le fallback `?? TYPE_CONFIG.churn_prediction` fait que TOUS les insights affichent "Risque de churn" quel que soit leur type reel.

### 2. Page SSR pure — pas d'interactivite

La page est un `async function` server component. Aucun handler onClick, aucun `useState`, aucun appel API client. Les boutons "Reconnaître"/"Rejeter" (s'ils existent dans le screenshot) sont purement decoratifs.

### 3. Pas d'appel au PATCH backend

Le backend `insights-crud` expose un endpoint PATCH complet avec machine a etats, mais le frontend ne l'appelle jamais.

---

## Solution : Conversion hybride SSR + Client

### Architecture cible

```
page.tsx (server component)
  └── Fetch initial SSR (insights + stats via Edge Function)
  └── <InsightsClient insights={data} stats={stats} />
        ├── InsightStatsCards (4 KPI)
        ├── InsightFilters (type tabs + status + sort)
        └── InsightCard[] (avec boutons interactifs)
              ├── Reconnaître → PATCH { status: 'acknowledged' }
              ├── Rejeter → PATCH { status: 'dismissed' } (avec confirmation)
              └── Voir le compte → lien /dashboard/accounts/{account_id}
```

---

## API Backend disponible (deja implementee, ne pas modifier)

### Base URL
```
${NEXT_PUBLIC_SUPABASE_URL}/functions/v1/insights-crud
```

### Auth
Header `Authorization: Bearer <jwt_utilisateur>` (token Supabase Auth standard).

### Endpoints

#### Liste paginee
```
GET /functions/v1/insights-crud?status=active&sort=created_at&page=1&per_page=50
```

**Query params :**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `insight_type` | string (csv) | — | `churn_prediction`, `expansion_opportunity`, `renewal_alert`, `payment_risk`, `usage_drop` |
| `priority` | string (csv) | — | `low`, `medium`, `high`, `critical` |
| `status` | string (csv) | `active` | `active`, `acknowledged`, `resolved`, `dismissed` |
| `account_id` | uuid | — | Insights d'un compte specifique |
| `sort` | string | `created_at` | `created_at`, `priority`, `confidence_score`, `mrr_impact_cents` |
| `page` | number | `1` | Page courante |
| `per_page` | number | `20` | Max 100 |

**Reponse :**
```json
{
  "data": [
    {
      "id": "uuid",
      "organization_id": "uuid",
      "account_id": "uuid",
      "insight_type": "churn_prediction",
      "title": "Risque de churn critique detecte",
      "description": "Ce compte presente un risque de churn de 85%...",
      "recommended_action": "Intervention immediate du CSM requise...",
      "priority": "critical",
      "confidence_score": 85.00,
      "mrr_impact_cents": 150000,
      "status": "active",
      "source_scores": { "churn_risk_score": 85, "health_score": 25 },
      "acknowledged_at": null,
      "dismissed_at": null,
      "created_at": "2026-03-05T10:00:00Z"
    }
  ],
  "pagination": { "page": 1, "per_page": 20, "total": 42, "total_pages": 3 }
}
```

#### Stats agregees
```
GET /functions/v1/insights-crud?stats=true
```

**Reponse :**
```json
{
  "data": {
    "total": 42,
    "total_mrr_impact_cents": 3500000,
    "by_type": { "churn_prediction": 12, "expansion_opportunity": 8, ... },
    "by_priority": { "critical": 6, "high": 15, ... },
    "by_status": { "active": 35, "acknowledged": 7 }
  }
}
```

#### Transition de statut (PATCH)
```
PATCH /functions/v1/insights-crud?id=<uuid>
Content-Type: application/json

{ "status": "acknowledged" }
```

**Transitions autorisees :**
| Depuis | Vers autorise |
|--------|---------------|
| `active` | `acknowledged`, `resolved`, `dismissed` |
| `acknowledged` | `resolved`, `dismissed` |
| `resolved` | aucune (terminal) |
| `dismissed` | aucune (terminal) |

**Reponse succes :** `{ "data": { /* insight mis a jour */ } }`

**Erreur :** `422 { "error": "Cannot transition from 'resolved' to 'active'. Allowed: none" }`

**Timestamps mis a jour automatiquement :**
- `acknowledged` → `acknowledged_at` + `acknowledged_by` (user_id)
- `resolved` → `resolved_at`
- `dismissed` → `dismissed_at`

---

## Implementation detaillee

### Etape 1 — Types TypeScript

Creer `src/lib/types/insights.ts` :

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
  acknowledged_at: string | null
  acknowledged_by: string | null
  resolved_at: string | null
  dismissed_at: string | null
  created_at: string
  updated_at: string
}

export interface InsightStats {
  total: number
  total_mrr_impact_cents: number
  by_type: Record<string, number>
  by_priority: Record<string, number>
  by_status: Record<string, number>
}

export interface InsightPagination {
  page: number
  per_page: number
  total: number
  total_pages: number
}
```

### Etape 2 — Helper API fetch

Creer `src/lib/api/insights.ts` :

```typescript
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import type { Insight, InsightStats, InsightPagination, InsightStatus } from '@/lib/types/insights'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!

async function getAuthHeaders(): Promise<Record<string, string>> {
  const supabase = createSupabaseBrowserClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')
  return {
    'Authorization': `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  }
}

export async function fetchInsights(params: {
  status?: string
  insight_type?: string
  priority?: string
  sort?: string
  page?: number
  per_page?: number
}): Promise<{ data: Insight[]; pagination: InsightPagination }> {
  const headers = await getAuthHeaders()
  const searchParams = new URLSearchParams()
  if (params.status) searchParams.set('status', params.status)
  if (params.insight_type) searchParams.set('insight_type', params.insight_type)
  if (params.priority) searchParams.set('priority', params.priority)
  if (params.sort) searchParams.set('sort', params.sort)
  if (params.page) searchParams.set('page', String(params.page))
  if (params.per_page) searchParams.set('per_page', String(params.per_page))

  const res = await fetch(
    `${SUPABASE_URL}/functions/v1/insights-crud?${searchParams}`,
    { headers }
  )
  if (!res.ok) throw new Error(`Failed to fetch insights: ${res.status}`)
  return res.json()
}

export async function fetchInsightStats(): Promise<InsightStats> {
  const headers = await getAuthHeaders()
  const res = await fetch(
    `${SUPABASE_URL}/functions/v1/insights-crud?stats=true`,
    { headers }
  )
  if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`)
  const json = await res.json()
  return json.data
}

export async function updateInsightStatus(id: string, status: InsightStatus): Promise<Insight> {
  const headers = await getAuthHeaders()
  const res = await fetch(
    `${SUPABASE_URL}/functions/v1/insights-crud?id=${id}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status }),
    }
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || `Failed to update: ${res.status}`)
  }
  const json = await res.json()
  return json.data
}
```

### Etape 3 — Composant `InsightCard` (client component)

Creer `src/components/insights/InsightCard.tsx` :

```tsx
'use client'

import { useState } from 'react'
import { AlertTriangle, TrendingUp, Activity, CreditCard, ArrowDown, CheckCircle, X, ExternalLink } from 'lucide-react'
import { updateInsightStatus } from '@/lib/api/insights'
import { formatMrr } from '@/lib/segment-queries'
import type { Insight, InsightStatus } from '@/lib/types/insights'

const TYPE_CONFIG = {
  churn_prediction: { label: 'Risque de churn', icon: AlertTriangle, color: 'text-red-600', bg: 'bg-red-50' },
  expansion_opportunity: { label: 'Expansion', icon: TrendingUp, color: 'text-blue-600', bg: 'bg-blue-50' },
  renewal_alert: { label: 'Renouvellement', icon: Activity, color: 'text-amber-600', bg: 'bg-amber-50' },
  payment_risk: { label: 'Paiement', icon: CreditCard, color: 'text-rose-600', bg: 'bg-rose-50' },
  usage_drop: { label: 'Baisse d\'usage', icon: ArrowDown, color: 'text-orange-600', bg: 'bg-orange-50' },
} as const

const PRIORITY_CONFIG = {
  critical: { label: 'CRITIQUE', color: 'text-red-700 bg-red-100' },
  high: { label: 'ELEVEE', color: 'text-orange-700 bg-orange-100' },
  medium: { label: 'MOYENNE', color: 'text-amber-700 bg-amber-100' },
  low: { label: 'FAIBLE', color: 'text-slate-500 bg-slate-100' },
} as const

interface InsightCardProps {
  insight: Insight
  onStatusChange: (id: string, newStatus: InsightStatus) => void
}

export function InsightCard({ insight, onStatusChange }: InsightCardProps) {
  const [isUpdating, setIsUpdating] = useState(false)
  const [showConfirmDismiss, setShowConfirmDismiss] = useState(false)
  const [showAction, setShowAction] = useState(false)

  const typeConf = TYPE_CONFIG[insight.insight_type] ?? TYPE_CONFIG.churn_prediction
  const priorityConf = PRIORITY_CONFIG[insight.priority] ?? PRIORITY_CONFIG.medium
  const Icon = typeConf.icon

  const canAcknowledge = insight.status === 'active'
  const canDismiss = insight.status === 'active' || insight.status === 'acknowledged'

  async function handleTransition(targetStatus: InsightStatus) {
    if (isUpdating) return
    setIsUpdating(true)
    try {
      await updateInsightStatus(insight.id, targetStatus)
      onStatusChange(insight.id, targetStatus)
    } catch (err) {
      console.error('Failed to update insight:', err)
      // TODO: toast notification d'erreur
    } finally {
      setIsUpdating(false)
      setShowConfirmDismiss(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 hover:shadow-sm transition-shadow">
      <div className="flex items-start gap-4">
        {/* Icon */}
        <div className={`w-10 h-10 rounded-lg ${typeConf.bg} flex items-center justify-center shrink-0`}>
          <Icon className={`w-5 h-5 ${typeConf.color}`} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${priorityConf.color}`}>
              {priorityConf.label}
            </span>
            <span className={`text-xs font-medium ${typeConf.color}`}>
              {typeConf.label}
            </span>
          </div>

          <h3 className="font-semibold text-slate-900 text-sm mb-1">{insight.title}</h3>

          {insight.description && (
            <p className="text-sm text-slate-500 mb-2">{insight.description}</p>
          )}

          <div className="flex items-center gap-4 text-xs text-slate-400 mb-2">
            {insight.mrr_impact_cents != null && insight.mrr_impact_cents > 0 && (
              <span className="font-semibold text-slate-700">
                MRR : {formatMrr(insight.mrr_impact_cents)}
              </span>
            )}
            {insight.confidence_score != null && (
              <span>Confiance : {Math.round(insight.confidence_score)}%</span>
            )}
            <span>{timeAgo(insight.created_at)}</span>
            {insight.account_id && (
              <a
                href={`/dashboard/accounts/${insight.account_id}`}
                className="text-indigo-600 hover:text-indigo-800 inline-flex items-center gap-1"
              >
                <ExternalLink className="w-3 h-3" /> Voir le compte
              </a>
            )}
          </div>

          {/* Action recommandee pliable */}
          {insight.recommended_action && (
            <div>
              <button
                onClick={() => setShowAction(!showAction)}
                className="text-xs text-indigo-600 font-medium hover:text-indigo-800"
              >
                {showAction ? '▾' : '▸'} Action recommandee
              </button>
              {showAction && (
                <p className="text-xs text-indigo-700 mt-1 pl-3 border-l-2 border-indigo-200">
                  {insight.recommended_action}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          {canAcknowledge && (
            <button
              onClick={() => handleTransition('acknowledged')}
              disabled={isUpdating}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100 disabled:opacity-50 transition-colors"
            >
              <CheckCircle className="w-3.5 h-3.5" />
              Reconnaitre
            </button>
          )}
          {canDismiss && !showConfirmDismiss && (
            <button
              onClick={() => setShowConfirmDismiss(true)}
              disabled={isUpdating}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-500 bg-slate-50 rounded-lg hover:bg-slate-100 disabled:opacity-50 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
              Rejeter
            </button>
          )}
          {showConfirmDismiss && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => handleTransition('dismissed')}
                disabled={isUpdating}
                className="px-2 py-1 text-xs font-medium text-red-700 bg-red-50 rounded hover:bg-red-100 disabled:opacity-50"
              >
                Confirmer
              </button>
              <button
                onClick={() => setShowConfirmDismiss(false)}
                className="px-2 py-1 text-xs text-slate-500 hover:text-slate-700"
              >
                Annuler
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const hours = Math.floor(diff / 3600000)
  if (hours < 1) return 'Il y a moins d\'1h'
  if (hours < 24) return `Il y a ${hours}h`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'Hier'
  return `Il y a ${days}j`
}
```

### Etape 4 — Composant client principal

Creer `src/components/insights/InsightsClient.tsx` :

```tsx
'use client'

import { useState, useCallback } from 'react'
import { InsightCard } from './InsightCard'
import { fetchInsights } from '@/lib/api/insights'
import { formatMrr } from '@/lib/segment-queries'
import type { Insight, InsightStatus, InsightStats, InsightPagination } from '@/lib/types/insights'

const TYPE_TABS = [
  { key: '', label: 'Tous' },
  { key: 'churn_prediction', label: 'Risque de churn' },
  { key: 'expansion_opportunity', label: 'Expansion' },
  { key: 'renewal_alert', label: 'Renouvellement' },
  { key: 'payment_risk', label: 'Paiement' },
  { key: 'usage_drop', label: 'Baisse d\'usage' },
] as const

const STATUS_TABS = [
  { key: 'active', label: 'Actifs' },
  { key: 'acknowledged', label: 'Reconnus' },
  { key: 'resolved', label: 'Resolus' },
  { key: 'dismissed', label: 'Rejetes' },
] as const

const SORT_OPTIONS = [
  { key: 'created_at', label: 'Date' },
  { key: 'priority', label: 'Priorite' },
  { key: 'confidence_score', label: 'Confiance' },
  { key: 'mrr_impact_cents', label: 'Impact MRR' },
] as const

interface InsightsClientProps {
  initialInsights: Insight[]
  initialPagination: InsightPagination
  initialStats: InsightStats
}

export function InsightsClient({ initialInsights, initialPagination, initialStats }: InsightsClientProps) {
  const [insights, setInsights] = useState(initialInsights)
  const [pagination, setPagination] = useState(initialPagination)
  const [stats] = useState(initialStats)

  // Filters
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('active')
  const [sort, setSort] = useState('created_at')
  const [page, setPage] = useState(1)
  const [isLoading, setIsLoading] = useState(false)

  const loadInsights = useCallback(async (params: {
    status?: string
    insight_type?: string
    sort?: string
    page?: number
  }) => {
    setIsLoading(true)
    try {
      const result = await fetchInsights({
        status: params.status ?? statusFilter,
        insight_type: params.insight_type ?? typeFilter || undefined,
        sort: params.sort ?? sort,
        page: params.page ?? page,
        per_page: 50,
      })
      setInsights(result.data)
      setPagination(result.pagination)
    } catch (err) {
      console.error('Failed to load insights:', err)
    } finally {
      setIsLoading(false)
    }
  }, [statusFilter, typeFilter, sort, page])

  // Optimistic status update : retirer l'insight de la liste courante
  function handleStatusChange(id: string, _newStatus: InsightStatus) {
    setInsights(prev => prev.filter(i => i.id !== id))
  }

  function handleTypeChange(type: string) {
    setTypeFilter(type)
    setPage(1)
    loadInsights({ insight_type: type || undefined, page: 1 })
  }

  function handleStatusFilterChange(status: string) {
    setStatusFilter(status)
    setPage(1)
    loadInsights({ status, page: 1 })
  }

  function handleSortChange(newSort: string) {
    setSort(newSort)
    loadInsights({ sort: newSort })
  }

  function handlePageChange(newPage: number) {
    setPage(newPage)
    loadInsights({ page: newPage })
  }

  const activeCount = stats.by_status?.active ?? 0
  const criticalCount = stats.by_priority?.critical ?? 0
  const totalMrrImpact = stats.total_mrr_impact_cents ?? 0
  const expansionCount = stats.by_type?.expansion_opportunity ?? 0

  return (
    <main className="px-8 py-8 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Insights IA</h1>
        <p className="text-slate-500 mt-1">
          {activeCount > 0
            ? `${activeCount} insights actifs — ${formatMrr(totalMrrImpact)} de MRR impacte`
            : 'Detections automatiques basees sur vos donnees'}
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="Insights actifs" value={activeCount} />
        <KpiCard label="Critiques" value={criticalCount} color="text-red-600" />
        <KpiCard label="MRR a risque" value={formatMrr(totalMrrImpact)} />
        <KpiCard label="Expansions" value={expansionCount} color="text-blue-600" />
      </div>

      {/* Type filter tabs */}
      <div className="flex flex-wrap gap-2">
        {TYPE_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => handleTypeChange(tab.key)}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
              typeFilter === tab.key
                ? 'bg-indigo-600 text-white'
                : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Status + Sort */}
      <div className="flex items-center gap-6 text-sm">
        <div className="flex items-center gap-1">
          <span className="text-slate-400">Statut :</span>
          {STATUS_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => handleStatusFilterChange(tab.key)}
              className={`px-3 py-1 rounded text-sm transition-colors ${
                statusFilter === tab.key
                  ? 'font-semibold text-slate-900'
                  : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-slate-400">Tri :</span>
          {SORT_OPTIONS.map(opt => (
            <button
              key={opt.key}
              onClick={() => handleSortChange(opt.key)}
              className={`px-3 py-1 rounded text-sm transition-colors ${
                sort === opt.key
                  ? 'font-semibold text-slate-900'
                  : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Insights list */}
      <div className={`space-y-3 ${isLoading ? 'opacity-50' : ''}`}>
        {insights.length === 0 ? (
          <div className="text-center py-12 text-slate-400">
            {statusFilter === 'active'
              ? 'Aucun insight actif — vos comptes sont en bonne sante'
              : 'Aucun insight ne correspond aux filtres selectionnes'}
          </div>
        ) : (
          insights.map(insight => (
            <InsightCard
              key={insight.id}
              insight={insight}
              onStatusChange={handleStatusChange}
            />
          ))
        )}
      </div>

      {/* Pagination */}
      {pagination.total_pages > 1 && (
        <div className="flex items-center justify-center gap-4 pt-4">
          <button
            onClick={() => handlePageChange(page - 1)}
            disabled={page <= 1}
            className="px-3 py-1 text-sm text-slate-600 hover:text-slate-900 disabled:opacity-30"
          >
            Precedent
          </button>
          <span className="text-sm text-slate-500">
            Page {pagination.page}/{pagination.total_pages} — {pagination.total} resultats
          </span>
          <button
            onClick={() => handlePageChange(page + 1)}
            disabled={page >= pagination.total_pages}
            className="px-3 py-1 text-sm text-slate-600 hover:text-slate-900 disabled:opacity-30"
          >
            Suivant
          </button>
        </div>
      )}
    </main>
  )
}

function KpiCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <p className="text-xs text-slate-400 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color ?? 'text-slate-900'}`}>{value}</p>
    </div>
  )
}
```

### Etape 5 — Page server component (reecrite)

Reecrire `src/app/dashboard/insights/page.tsx` :

```tsx
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { InsightsClient } from '@/components/insights/InsightsClient'
import { EmptyState } from '@/components/EmptyState'
import { Lightbulb } from 'lucide-react'

async function getSessionToken(): Promise<{ token: string; orgId: string } | null> {
  const supabase = createSupabaseServerClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null
  const { data: profile } = await supabase
    .from('profiles_')
    .select('organization_id')
    .eq('auth_user_id', session.user.id)
    .maybeSingle()
  if (!profile?.organization_id) return null
  return { token: session.access_token, orgId: profile.organization_id }
}

export default async function InsightsPage() {
  const auth = await getSessionToken()
  if (!auth) redirect('/auth/login')

  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const headers = {
    'Authorization': `Bearer ${auth.token}`,
    'Content-Type': 'application/json',
  }

  // Fetch initial data SSR (insights + stats en parallele)
  const [insightsRes, statsRes] = await Promise.all([
    fetch(`${baseUrl}/functions/v1/insights-crud?status=active&per_page=50`, { headers }),
    fetch(`${baseUrl}/functions/v1/insights-crud?stats=true`, { headers }),
  ])

  const insightsJson = insightsRes.ok ? await insightsRes.json() : { data: [], pagination: { page: 1, per_page: 50, total: 0, total_pages: 0 } }
  const statsJson = statsRes.ok ? await statsRes.json() : { data: { total: 0, total_mrr_impact_cents: 0, by_type: {}, by_priority: {}, by_status: {} } }

  if (insightsJson.data.length === 0 && (statsJson.data?.total ?? 0) === 0) {
    return (
      <main className="px-8 py-8">
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Insights IA</h1>
        <div className="bg-white rounded-xl border border-slate-200">
          <EmptyState
            icon={Lightbulb}
            title="Aucun insight genere"
            description="Les insights seront generes automatiquement apres la synchronisation de vos donnees et le calcul des scores."
          />
        </div>
      </main>
    )
  }

  return (
    <InsightsClient
      initialInsights={insightsJson.data}
      initialPagination={insightsJson.pagination}
      initialStats={statsJson.data}
    />
  )
}
```

---

## Schema DB de reference — table `ai_insights`

```sql
CREATE TABLE public.ai_insights (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id      UUID REFERENCES accounts(id) ON DELETE SET NULL,
  insight_type    TEXT NOT NULL,      -- churn_prediction, expansion_opportunity, renewal_alert, payment_risk, usage_drop
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  recommended_action TEXT,
  priority        TEXT NOT NULL DEFAULT 'medium',  -- low, medium, high, critical
  status          TEXT NOT NULL DEFAULT 'active',  -- active, acknowledged, resolved, dismissed
  confidence_score NUMERIC(5,2),
  mrr_impact_cents INTEGER,
  source_scores   JSONB,
  ai_model_version TEXT,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES profiles_(id),
  resolved_at     TIMESTAMPTZ,
  dismissed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Criteres d'acceptation

- [ ] La page Insights appelle l'Edge Function `insights-crud` (pas de query directe Supabase)
- [ ] Les insights affichent le bon type (churn, expansion, etc.) et pas toujours "Risque de churn"
- [ ] Le bouton "Reconnaitre" appelle `PATCH /insights-crud?id=X` avec `{ status: 'acknowledged' }`
- [ ] Le bouton "Rejeter" demande confirmation avant d'appeler `PATCH` avec `{ status: 'dismissed' }`
- [ ] L'insight disparait de la liste "Actifs" apres acknowledge/dismiss (optimistic UI)
- [ ] Les filtres par type, statut et tri fonctionnent via l'API
- [ ] La pagination fonctionne
- [ ] Les 4 KPI cards affichent les stats agregees
- [ ] L'empty state s'affiche quand aucun insight n'existe
- [ ] Aucun PII n'est affiche (uniquement scores, MRR, types)
- [ ] `npm run build` passe sans erreur

## Fichiers a creer/modifier

| Fichier | Action |
|---------|--------|
| `src/lib/types/insights.ts` | Creer — types TypeScript |
| `src/lib/api/insights.ts` | Creer — helpers fetch API |
| `src/components/insights/InsightCard.tsx` | Creer — carte interactive avec boutons |
| `src/components/insights/InsightsClient.tsx` | Creer — composant client principal |
| `src/app/dashboard/insights/page.tsx` | Reecrire — SSR + hydration client |

## Ne pas modifier

- `supabase/functions/insights-crud/index.ts` — backend deja complet
- `supabase/functions/_shared/insight-rules.ts` — regles de generation
- Aucune migration necessaire
