# Prompt Frontend — UX Audit Phase 1+2 : Sidebar, Pages, Dashboard actionnable

## Contexte

Le backend Sentio AI a implemente une reference complete dans le repo backend (`sentio-dev-backend`) couvrant :
- Sidebar navigation avec 6 items
- Dashboard enrichi (widgets risque + expansion + segments)
- 6 nouvelles pages (segments, accounts, playbooks, insights, settings)
- Composants reutilisables (ScoreBadge, EmptyState, Breadcrumbs)
- Filtres de segment in-memory alignes avec le backend scoring.ts

Ce prompt decrit les changements a porter dans le repo frontend separe. Le code de reference est dans `sentio-dev-backend/src/` — les fichiers sont fonctionnels et servent de specification exacte.

---

## Architecture implementee

### Routes

| Route | Type | Description |
|-------|------|-------------|
| `/dashboard` | Server Component | Vue d'ensemble avec KPIs, segments, widgets risque/expansion |
| `/dashboard/accounts` | Server Component | Liste complete des comptes avec scores |
| `/dashboard/segments` | Server Component | 8 cartes segment avec count, MRR, sante moyenne |
| `/dashboard/segments/[segment]` | Server Component | Detail segment avec tableau comptes, export CSV |
| `/dashboard/playbooks` | Server Component | Playbooks avec statut, priorite, eligible count |
| `/dashboard/insights` | Server Component | Insights IA avec type, priorite, statut, impact MRR |
| `/dashboard/settings` | Server Component | Integrations Stripe/HubSpot, webhook config, scoring info |

### Layout

```
dashboard/layout.tsx
├── Sidebar (fixed left, 16rem)
│   ├── Logo Sentio AI
│   ├── Navigation (6 items, etat actif via usePathname)
│   └── User section (nom, role, logout)
└── <main> (padding-left 16rem)
    └── {children}
```

Le layout fetch l'utilisateur et le profil une seule fois, puis passe `userName` et `userRole` a la Sidebar.

---

## Composants a creer/adapter

### 1. Sidebar (`src/components/Sidebar.tsx`)

Client component utilisant `usePathname()` pour l'etat actif.

**Items de navigation :**
```typescript
const NAV_ITEMS = [
  { href: '/dashboard', label: 'Vue d\'ensemble', icon: LayoutDashboard },
  { href: '/dashboard/accounts', label: 'Comptes clients', icon: Users },
  { href: '/dashboard/segments', label: 'Segments', icon: PieChart },
  { href: '/dashboard/playbooks', label: 'Playbooks', icon: BookOpen },
  { href: '/dashboard/insights', label: 'Insights IA', icon: Lightbulb },
  { href: '/dashboard/settings', label: 'Paramètres', icon: Settings },
]
```

**Logique etat actif :**
- `/dashboard` exact match uniquement
- Toutes les autres routes : `pathname.startsWith(href)`

**Logout :** `supabase.auth.signOut()` puis redirect `/auth/login`

**Icones :** Lucide React (`lucide-react` — deja installe dans le backend)

---

### 2. ScoreBadge (`src/components/ScoreBadge.tsx`)

Badge colore semantique pour afficher les scores. Trois modes : `health`, `churn`, `expansion`.

**Props :**
```typescript
interface ScoreBadgeProps {
  score: number | null
  type?: 'health' | 'churn' | 'expansion'
  showLabel?: boolean  // affiche le texte "Sain", "Élevé", etc.
  size?: 'sm' | 'md'
}
```

**Seuils par type :**

| Type | >= 70 | 40-69 | < 40 |
|------|-------|-------|------|
| health | emerald "Sain" | amber "Attention" | red "Critique" |
| churn | red "Élevé" | amber "Modéré" | emerald "Faible" |
| expansion | blue "Fort" | slate "Modéré" | slate "Faible" |

Score `null` → tiret "—" en slate-400.

---

### 3. EmptyState (`src/components/EmptyState.tsx`)

Composant reutilisable pour les ecrans vides.

```typescript
interface EmptyStateProps {
  icon?: LucideIcon      // default: Inbox
  title: string
  description: string
  actionLabel?: string   // texte du bouton CTA
  actionHref?: string    // lien du CTA
}
```

**Messages par page :**

| Page | Titre | Description | CTA |
|------|-------|-------------|-----|
| Comptes | "Aucun compte" | "Connectez Stripe dans les parametres..." | "Configurer Stripe" → /dashboard/settings |
| Segments detail | "Aucun compte dans ce segment" | "Aucun compte ne correspond aux criteres..." | — |
| Playbooks | "Aucun playbook" | "Les playbooks seront crees automatiquement..." | — |
| Insights | "Aucun insight genere" | "Les insights seront generes automatiquement..." | — |
| Syncs (dashboard) | "Aucune synchronisation effectuee" | "Connectez Stripe dans les Parametres..." | lien inline |

---

### 4. Breadcrumbs (`src/components/Breadcrumbs.tsx`)

Utilise sur la page segment detail.

```typescript
interface BreadcrumbItem {
  label: string
  href?: string  // clickable si present
}
```

Exemple : `Segments > À risque léger` (premier clickable, dernier pas)

---

## Filtres de segment (CRITIQUE — source de verite)

Les filtres de segment DOIVENT etre identiques entre le frontend et le backend. Voici la source de verite alignee avec `scoring.ts` :

```typescript
type SegmentKey =
  | 'champions' | 'en_expansion' | 'stables' | 'a_risque_leger'
  | 'en_danger_critique' | 'impayes' | 'en_churn' | 'nouveaux'

const SEGMENT_FILTERS: Record<SegmentKey, (a: Account) => boolean> = {
  champions: (a) =>
    (a.health_score ?? 0) >= 80 && (a.churn_risk_score ?? 100) < 50,

  en_expansion: (a) =>
    (a.expansion_score ?? 0) >= 70 &&
    (a.health_score ?? 0) >= 60 &&
    (a.health_score ?? 0) < 80 &&
    (a.churn_risk_score ?? 100) < 50,

  stables: (a) =>
    (a.mrr_cents ?? 0) > 0 &&
    (a.churn_risk_score ?? 100) < 50 &&
    (a.health_score ?? 0) < 80 &&
    !((a.expansion_score ?? 0) >= 70 && (a.health_score ?? 0) >= 60),

  a_risque_leger: (a) =>
    (a.churn_risk_score ?? 0) >= 50 &&
    (a.churn_risk_score ?? 0) < 70 &&
    (a.mrr_cents ?? 0) > 0,

  en_danger_critique: (a) =>
    (a.churn_risk_score ?? 0) >= 70 && (a.mrr_cents ?? 0) > 0,

  impayes: (a) =>
    (a.churn_risk_score ?? 0) > 80 &&
    (a.health_score ?? 0) < 50 &&
    (a.mrr_cents ?? 0) > 0,

  en_churn: (a) => (a.mrr_cents ?? 0) === 0,

  nouveaux: (a) => {
    if (!a.created_at) return false
    const diffMs = Date.now() - new Date(a.created_at).getTime()
    return diffMs < 90 * 24 * 60 * 60 * 1000
  },
}
```

**IMPORTANT :** Si le frontend a deja un fichier `segment-queries.ts` ou equivalent, remplacer ses filtres par ceux ci-dessus. Ces filtres doivent etre utilises PARTOUT : page liste segments, page detail segment, export CSV.

### Metadata des segments (couleurs, labels)

```typescript
const SEGMENTS: SegmentMeta[] = [
  { key: 'champions',          label: 'Champions',           color: 'text-emerald-700', bgColor: 'bg-emerald-50', borderColor: 'border-emerald-200' },
  { key: 'en_expansion',       label: 'En expansion',        color: 'text-blue-700',    bgColor: 'bg-blue-50',    borderColor: 'border-blue-200' },
  { key: 'stables',            label: 'Stables',             color: 'text-slate-700',   bgColor: 'bg-slate-50',   borderColor: 'border-slate-200' },
  { key: 'a_risque_leger',     label: 'À risque léger',      color: 'text-amber-700',   bgColor: 'bg-amber-50',   borderColor: 'border-amber-200' },
  { key: 'en_danger_critique', label: 'En danger critique',  color: 'text-red-700',     bgColor: 'bg-red-50',     borderColor: 'border-red-200' },
  { key: 'impayes',            label: 'Impayés',             color: 'text-rose-700',    bgColor: 'bg-rose-50',    borderColor: 'border-rose-200' },
  { key: 'en_churn',           label: 'En churn',            color: 'text-gray-700',    bgColor: 'bg-gray-50',    borderColor: 'border-gray-200' },
  { key: 'nouveaux',           label: 'Nouveaux (< 90j)',    color: 'text-indigo-700',  bgColor: 'bg-indigo-50',  borderColor: 'border-indigo-200' },
]
```

---

## Pages a implementer

### 1. Dashboard (`/dashboard`)

**Data fetching :** une seule query `accounts` par org_id (.limit(10000)), tout le reste est calcule in-memory.

**Sections :**

```
┌──────────────────────────────────────────────────────┐
│ Vue d'ensemble                    [Actualiser données]│
│ Tableau de bord de votre base client                  │
├──────────────────────────────────────────────────────┤
│ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐    │
│ │Comptes  │ │MRR Total│ │Santé moy│ │À risque │    │
│ │ 107     │ │35 350 € │ │   56    │ │   12    │    │
│ └─────────┘ └─────────┘ └─────────┘ └─────────┘    │
│                                                      │
│ ┌──────────┐┌──────────┐┌──────────┐┌──────────┐    │
│ │Champions ││Expansion ││Stables   ││À risque  │    │
│ │ 5       ││ 3       ││ 42      ││ 101     │    │  <- liens vers /segments/xxx
│ └──────────┘└──────────┘└──────────┘└──────────┘    │
│                                                      │
│ ┌── Comptes à risque ──┐ ┌── Opportunités ────┐     │
│ │ cus_xxx    84 Élevé  │ │ cus_yyy  82 Fort   │     │
│ │ cus_zzz    78 Élevé  │ │ cus_www  75 Fort   │     │  <- top 5 chaque
│ │        [Voir tout] → │ │      [Voir tout] → │     │
│ └──────────────────────┘ └────────────────────┘     │
│                                                      │
│ ┌── Synchronisations récentes ─────────────────┐    │
│ │ completed  stripe  full_sync  42 enr.  10/03 │    │
│ └──────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

**KPI cards :** avec icones Lucide (Users, CreditCard, AlertTriangle). Score sante colore (emerald >= 70, amber >= 40, red < 40). Comptes a risque : rouge si > 0, vert sinon.

**Segment quick-links :** 4 premiers segments (Champions, En expansion, Stables, À risque léger), colores selon la metadata, cliquables.

**Widget "Comptes à risque" :** top 5 par churn_risk desc, avec ScoreBadge type=churn showLabel. Lien "Voir tout" → `/dashboard/segments/en_danger_critique`.

**Widget "Opportunités d'expansion" :** top 5 par expansion_score desc (filtre expansion >= 70 AND health >= 60). Lien "Voir tout" → `/dashboard/segments/en_expansion`.

**Empty state syncs :** quand aucune sync, afficher un message avec lien vers `/dashboard/settings`.

---

### 2. Page Segments (`/dashboard/segments`)

8 cartes en grille (1 col mobile, 2 md, 4 xl). Chaque carte :
- Label colore du segment (metadata)
- Count comptes (filtre in-memory)
- MRR total du segment
- Score sante moyen (ScoreBadge)
- Fleche → lien vers `/dashboard/segments/[key]`

---

### 3. Page Segment Detail (`/dashboard/segments/[segment]`)

**IMPORTANT :** utiliser le filtrage in-memory (`SEGMENT_FILTERS[segment]`) et NON la RPC `get_segment_accounts()`. Cela garantit la coherence avec la page liste.

**Sections :**
- Breadcrumbs : `Segments > [Nom du segment]`
- Header : titre + badge colore + stats (count, MRR, sante moyenne)
- 3 stats cards : comptes, MRR, score sante moyen
- Bouton "Exporter CSV" → `${SUPABASE_URL}/functions/v1/export-segment-csv?segment=xxx`
- Tableau comptes : ID Stripe, ID HubSpot, Plan, MRR, Sieges, Renouvellement, Sante, Risque, Expansion
- Notice Zero-PII en bas
- EmptyState si 0 comptes

**Colonnes du tableau :**

| Colonne | Champ | Format |
|---------|-------|--------|
| ID Stripe | stripe_customer_id | mono text-xs |
| ID HubSpot | hubspot_company_id | mono text-xs slate-500 |
| Plan | plan_tier + billing_interval | capitalize + (annuel/mensuel) |
| MRR | mrr_cents | formatMrr (euros) |
| Sieges | seat_count / seat_limit | "5/10" ou "—" |
| Renouvellement | contract_end_date | toLocaleDateString('fr-FR') |
| Sante | health_score | ScoreBadge type=health |
| Risque | churn_risk_score | ScoreBadge type=churn |
| Expansion | expansion_score | ScoreBadge type=expansion |

---

### 4. Page Comptes (`/dashboard/accounts`)

Meme tableau que le segment detail mais sans filtre (tous les comptes). Tri par MRR desc. Header avec total comptes + MRR total. EmptyState guidant vers Settings.

---

### 5. Page Playbooks (`/dashboard/playbooks`)

**Data :** query directe `playbooks` table (pas l'Edge Function, sauf si besoin de `current_eligible_count` dynamique).

Pour le `current_eligible_count` dynamique, utiliser l'Edge Function :
```
GET ${SUPABASE_URL}/functions/v1/playbook-crud
Authorization: Bearer <jwt>
```
qui retourne chaque playbook enrichi avec `current_eligible_count`.

**Affichage :** grille de cartes (1 col mobile, 2 md, 3 xl). Chaque carte :
- Titre + badge statut (draft=slate, active=emerald, paused=amber, completed=blue, archived=gray)
- Description (line-clamp-2)
- Priorite coloree (critical=red, high=orange, medium=amber, low=slate)
- Badge "Template" si is_template
- Stats : eligible count (icone Zap), cibles, touches
- EmptyState si 0 playbooks

---

### 6. Page Insights (`/dashboard/insights`)

**Data :** query directe `ai_insights` table, order by created_at desc, limit 100.

**Header :** count actifs + MRR total impacte (somme impact_mrr_cents des insights actifs).

**Cartes :** liste verticale, chaque insight :
- Icone par type dans un carre colore (10x10)
- Titre + badges priorite + statut
- Description (line-clamp-2)
- Action recommandee en indigo
- Meta : type label, confiance %, impact MRR, temps relatif

**Types et icones :**

| Type | Label | Icone | Couleur |
|------|-------|-------|---------|
| churn_prediction | Prediction churn | AlertTriangle | red |
| expansion_opportunity | Opportunite expansion | TrendingUp | blue |
| renewal_alert | Alerte renouvellement | Activity | amber |
| payment_risk | Risque paiement | CreditCard | rose |
| usage_drop | Chute usage | ArrowDown | orange |

---

### 7. Page Parametres (`/dashboard/settings`)

**3 sections :**

**A. Integrations** (query `organization_integrations`) :
- 2 cartes : Stripe (violet) + HubSpot (orange)
- Chaque carte : nom, description, badge "Connecte"/"Non connecte", methode (OAuth/Cle API), account_id

**B. Webhook sortant** (query `webhook_configs`) :
- Si configure : endpoint URL (mono), badge actif/desactive, events actifs, dernier declenchement, echecs consecutifs
- Si non configure : icone Webhook + message + description

**C. Scoring** (statique) :
- Formule V1 : Financial 34% + Engagement 33% + Contract 33%
- Formule future : Usage 35% + Financial 25% + Engagement 20% + Contract 20%
- Note : "Usage tracker non connecte — dimension suspendue"

---

## Utilities a copier/creer

### formatMrr

```typescript
function formatMrr(cents: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100)
}
```

### timeAgo (pour insights)

```typescript
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

---

## Dependances requises

- `lucide-react` (icones) — verifier si deja installe, sinon `npm install lucide-react`
- Tailwind CSS 3.x (deja utilise)
- `@supabase/ssr` (deja utilise)

---

## Points d'attention

1. **Filtres de segment** : DOIVENT etre identiques au backend. Si le frontend a deja un fichier de filtres, le REMPLACER par ceux documentes ici.

2. **Source de donnees segment detail** : utiliser le filtrage in-memory (meme logique que la liste), PAS la RPC `get_segment_accounts()`. La RPC depend de `segment_memberships` qui peut avoir un delai de quelques heures.

3. **Export CSV segment** : le bouton pointe vers l'Edge Function `export-segment-csv`. L'auth est geree par le JWT dans le header. L'URL est : `${NEXT_PUBLIC_SUPABASE_URL}/functions/v1/export-segment-csv?segment=<key>`. Le frontend doit ajouter le header `Authorization: Bearer <jwt>` (via fetch, pas un simple lien `<a>`).

4. **Playbooks eligible count** : pour afficher le `current_eligible_count` dynamique, utiliser l'Edge Function `playbook-crud` GET (qui enrichit la reponse) plutot qu'une query directe sur la table.

5. **Zero-PII** : jamais d'email, nom, telephone. Les seuls identifiants affiches sont `stripe_customer_id` et `hubspot_company_id`.

6. **Montants** : stockes en centimes en base, affiches en euros via `formatMrr()`.

7. **Loading states** : le dashboard layout gere le skeleton via `loading.tsx`. Les pages enfants heritent du layout (sidebar reste visible pendant le chargement).

8. **Auth check** : le layout fait `getUser()` + redirect vers login. Les pages enfants n'ont pas besoin de re-verifier l'auth, mais doivent toujours scoper par `organization_id`.
