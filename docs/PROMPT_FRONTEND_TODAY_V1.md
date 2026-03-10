# Prompt Frontend — Page "Aujourd'hui" V1 : Actions groupees par priorite

## Contexte

La page "Aujourd'hui" actuelle affiche 107 cartes d'actions en liste plate, toutes identiques visuellement (meme score, meme MRR). C'est inutilisable — l'utilisateur ne sait pas par ou commencer.

**Objectif :** reorganiser cette page pour qu'elle soit actionnable. Grouper par priorite, limiter le volume visible, et fournir des filtres pour naviguer dans un grand nombre d'actions.

---

## IMPORTANT — Remplacement de la page existante

**Ce prompt REMPLACE la page "Aujourd'hui" existante. Il ne faut PAS creer une deuxieme page.**

Actions a faire cote frontend :
1. **Identifier la route existante** de la page "Aujourd'hui" (probablement `/dashboard/today` ou `/dashboard`)
2. **Remplacer son contenu** par l'implementation decrite ci-dessous
3. **Ne PAS ajouter un deuxieme nav item** "Aujourd'hui" dans la sidebar — il en existe deja un, le modifier si necessaire
4. **Supprimer** l'ancien composant/page qui affichait les 107 cartes plates

Si la sidebar a deja un item "Aujourd'hui", garder celui-la et mettre a jour son `href` vers `/dashboard/today` si different. Le backend reference (`sentio-dev-backend/src/components/Sidebar.tsx`) montre la structure cible — un seul item avec badge.

---

## Donnees sources

La page "Aujourd'hui" est alimentee par :
1. **Playbooks actifs** — via `GET /functions/v1/playbook-crud` (retourne `current_eligible_count` + `eligibility_criteria`)
2. **Comptes** — via Supabase query `accounts` (org_id, .limit(10000))
3. **Matching** — evaluer les `eligibility_criteria` de chaque playbook contre chaque compte (fonction `evaluateConditions` du backend)

**Le backend fournit des helpers purs dans `_shared/today-actions-helpers.ts` :**

```typescript
import {
  computeTodayActions,    // accounts + playbooks → TodayAction[]
  buildTodayActionsSummary, // TodayAction[] → { total, by_priority, by_category, mrr_at_risk, actions }
  getTopActionsByPriority,  // TodayAction[] + limit → { P0: [], P1: [], P2: [] }
  computeTriggerReasons,    // account → string[]
  sortTodayActions,         // actions → sorted (P0 > P1 > P2, MRR desc)
  priorityLabel,            // 'P0' → 'Critique'
  categoryLabel,            // 'churn_prevention' → 'Prévention churn'
} from '_shared/today-actions-helpers'
```

**Le frontend doit reimplementer cette logique cote client** (meme pattern que les segment filters in-memory). Les types et fonctions sont documentes ci-dessous.

---

## Route

| Route | Type | Description |
|-------|------|-------------|
| `/dashboard/today` | Client Component (interactif) | Actions prioritaires du jour, groupees par priorite |

---

## Sidebar — mise a jour

Le nav item "Aujourd'hui" est ajoute en premiere position dans la sidebar :

```typescript
const NAV_ITEMS = [
  { href: '/dashboard/today', label: "Aujourd'hui", icon: CalendarCheck, badge: true },
  { href: '/dashboard', label: 'Vue d\'ensemble', icon: LayoutDashboard },
  // ... reste inchange
]
```

**Badge :** affiche le nombre total d'actions (rouge, arrondi). `99+` si > 99. Masque si 0.

**Props Sidebar :** `todayActionCount?: number | null` — passe depuis le layout ou calcule dans la sidebar via un hook.

---

## Architecture de la page

```
┌───────────────────────────────────────────────────────────────────┐
│ Aujourd'hui — mardi 10 mars 2026                                  │
│ 107 actions prioritaires                                          │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────────┐             │
│ │ 8       │ │ 24      │ │ 75      │ │ 15 350 €    │             │
│ │Critiques│ │ Hautes  │ │Normales │ │ MRR à risque│             │
│ │ P0  🔴  │ │ P1  🟠  │ │ P2  🔵  │ │ (P0 + P1)  │             │
│ └─────────┘ └─────────┘ └─────────┘ └─────────────┘             │
│                                                                   │
│ [Filtres: segment ▾  priorite ▾  MRR min ▾  categorie ▾]        │
│                                                                   │
│ ── 🔴 Critiques (8) ──────────────────────── [Tout voir ▾] ──── │
│ ┌─────────────────────────────────────────────────────────────┐   │
│ │ ID Stripe     │ MRR    │ Santé │ Risque │ Raisons │ Actions│   │
│ │ cus_xxxxx     │ 890 €  │  28   │  84 🔴 │ Churn…  │ 2 PBs │   │
│ │ cus_yyyyy     │ 650 €  │  35   │  78 🔴 │ Santé…  │ 1 PB  │   │
│ │ cus_zzzzz     │ 520 €  │  22   │  92 🔴 │ Churn…  │ 3 PBs │   │
│ │ ... +5 comptes masques                              [Voir] │   │
│ └─────────────────────────────────────────────────────────────┘   │
│                                                                   │
│ ── 🟠 Hautes (24) ────────────────────────── [Tout voir ▾] ──── │
│ ┌─────────────────────────────────────────────────────────────┐   │
│ │ cus_aaaaa     │ 490 €  │  42   │  65 🟠 │ Risque… │ 1 PB  │   │
│ │ cus_bbbbb     │ 380 €  │  51   │  58 🟠 │ Renouv… │ 2 PBs │   │
│ │ ... +19 comptes masques                             [Voir] │   │
│ └─────────────────────────────────────────────────────────────┘   │
│                                                                   │
│ ── 🔵 Normales (75) ──────────────────────── [Tout voir ▾] ──── │
│ │ (collapsed par defaut — cliquer pour developper)            │   │
│                                                                   │
│ ── Export ─────────────────────────────────────────────────────── │
│ [Exporter CSV]  [Exporter JSON]                                   │
│ Utilise l'Edge Function export-playbook-accounts                  │
└───────────────────────────────────────────────────────────────────┘
```

---

## Composants a creer

### 1. TodayPage (`/dashboard/today/page.tsx`)

**Data fetching (Server Component wrapper ou useEffect) :**
1. Fetch playbooks actifs via Edge Function `playbook-crud` GET (avec JWT)
2. Fetch comptes via Supabase query `accounts.select(*).eq(org_id).limit(10000)`
3. Calculer les actions : `computeTodayActions(accounts, playbooks)` → `buildTodayActionsSummary(actions)`

**Etat local (Client Component) :**
- `expandedGroups: Set<'P0' | 'P1' | 'P2'>` — P0 et P1 ouverts par defaut, P2 ferme
- `filters: { segment?, priority?, mrrMin?, category? }`
- `showAll: Record<'P0' | 'P1' | 'P2', boolean>` — toggle "Voir tout" par groupe

---

### 2. TodaySummaryBar

4 cartes KPI en ligne :

| Carte | Valeur | Couleur | Icone |
|-------|--------|---------|-------|
| Critiques (P0) | count | red-500 | AlertTriangle |
| Hautes (P1) | count | amber-500 | AlertCircle |
| Normales (P2) | count | blue-500 | Info |
| MRR a risque | formatMrr(mrr_at_risk_cents) | slate-700 | CreditCard |

Chaque carte est cliquable → scroll vers la section correspondante.

---

### 3. TodayFilters

Barre de filtres horizontale, sticky sous le header.

| Filtre | Type | Options |
|--------|------|---------|
| Priorite | Select | Toutes, P0, P1, P2 |
| Segment | Select | 8 segments (Champions, En expansion, etc.) |
| Categorie | Select | Categories des playbooks matchant (churn_prevention, expansion, etc.) |
| MRR minimum | Input number | Filtre comptes >= N euros |

**Logique :**
- Les filtres s'appliquent sur la liste `actions` avant le groupement par priorite
- Le segment est determine in-memory via `SEGMENT_FILTERS` (meme source de verite que les autres pages)
- Reset : bouton "Reinitialiser" visible quand au moins un filtre est actif

---

### 4. TodayPriorityGroup

Section collapsible pour un niveau de priorite.

**Props :**
```typescript
interface TodayPriorityGroupProps {
  priority: 'P0' | 'P1' | 'P2'
  actions: TodayAction[]
  defaultExpanded: boolean  // P0/P1 = true, P2 = false
  initialLimit: number      // 5 par defaut
}
```

**Header de section :**
- Pastille coloree (rouge P0, orange P1, bleu P2)
- Label : `priorityLabel(priority)` + count entre parentheses
- Chevron collapsible
- MRR total du groupe

**Contenu :**
- Tableau compact (pas de cartes — trop de volume)
- Affiche `initialLimit` lignes par defaut
- Bouton "Voir les N restants" en bas si plus de lignes

---

### 5. TodayActionRow

Ligne du tableau pour un compte actionnable.

**Colonnes :**

| Colonne | Champ | Format |
|---------|-------|--------|
| ID Stripe | stripe_customer_id | mono text-xs, lien vers `/dashboard/accounts/[id]` si route existe |
| Plan | plan_tier | capitalize |
| MRR | mrr_cents | formatMrr() |
| Sante | health_score | ScoreBadge type=health |
| Risque churn | churn_risk_score | ScoreBadge type=churn |
| Raisons | trigger_reasons | Chips/tags compacts, max 2 visibles + "+N" |
| Playbooks | matching_playbooks | Count + tooltip avec titres |
| Renouvellement | days_to_renewal | "Xj" ou "—" |

**Interactions :**
- Hover : highlight la ligne
- Clic sur un playbook → lien vers `/dashboard/playbooks/[id]` si route existe

---

## Logique de priorite (a reimplementer cote frontend)

```typescript
// Identique au backend export-helpers.ts
function computePriority(
  churnRisk: number | null,
  daysToRenewal: number | null
): 'P0' | 'P1' | 'P2' {
  const risk = churnRisk ?? 0
  if (risk >= 70 && daysToRenewal !== null && daysToRenewal < 30) return 'P0'
  if (risk >= 50 || (daysToRenewal !== null && daysToRenewal < 60)) return 'P1'
  return 'P2'
}

function computeDaysToRenewal(
  contractEndDate: string | null,
  billingInterval: string | null
): number | null {
  if (!contractEndDate || billingInterval === 'monthly') return null
  const end = new Date(contractEndDate)
  const diffMs = end.getTime() - Date.now()
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24))
}
```

---

## Logique de trigger reasons (a reimplementer cote frontend)

```typescript
function computeTriggerReasons(account: Account): string[] {
  const reasons: string[] = []

  if ((account.churn_risk_score ?? 0) >= 70)
    reasons.push(`Risque churn critique (${Math.round(account.churn_risk_score!)}%)`)
  else if ((account.churn_risk_score ?? 0) >= 50)
    reasons.push(`Risque churn modéré (${Math.round(account.churn_risk_score!)}%)`)

  if ((account.health_score ?? 100) < 40)
    reasons.push(`Santé faible (${Math.round(account.health_score!)}%)`)

  const dtr = computeDaysToRenewal(account.contract_end_date, account.billing_interval)
  if (dtr !== null && dtr <= 60)
    reasons.push(`Renouvellement dans ${dtr}j`)

  if ((account.expansion_score ?? 0) >= 70)
    reasons.push(`Opportunité expansion (${Math.round(account.expansion_score!)}%)`)

  if ((account.mrr_cents ?? 0) === 0)
    reasons.push('MRR à zéro')

  return reasons
}
```

---

## Logique de matching (evaluateConditions)

Pour determiner quels comptes matchent quels playbooks, reimplementer `evaluateConditions` :

```typescript
type ComparisonOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in'

interface Condition {
  field: string
  operator: ComparisonOperator
  value: unknown
}

interface ConditionGroup {
  operator: 'AND' | 'OR'
  conditions: Condition[]
}

function evaluateCondition(condition: Condition, account: Record<string, unknown>): boolean {
  const val = account[condition.field]
  if (val === undefined || val === null) return false

  switch (condition.operator) {
    case 'eq':  return val === condition.value
    case 'neq': return val !== condition.value
    case 'gt':  return Number(val) > Number(condition.value)
    case 'gte': return Number(val) >= Number(condition.value)
    case 'lt':  return Number(val) < Number(condition.value)
    case 'lte': return Number(val) <= Number(condition.value)
    case 'in':  return Array.isArray(condition.value) && condition.value.includes(val)
    case 'not_in': return Array.isArray(condition.value) && !condition.value.includes(val)
    default: return false
  }
}

function evaluateConditions(group: ConditionGroup | null, account: Record<string, unknown>): boolean {
  if (!group || !group.conditions?.length) return true
  if (group.operator === 'OR')
    return group.conditions.some((c) => evaluateCondition(c, account))
  return group.conditions.every((c) => evaluateCondition(c, account))
}
```

---

## Matching comptes ↔ playbooks (algorithme)

```typescript
// Pour chaque playbook actif, evaluer quels comptes matchent
// Un compte peut matcher plusieurs playbooks → dedupliquer par account.id
// Chaque action = 1 compte unique avec la liste de ses playbooks matchants

interface TodayAction {
  account_id: string
  stripe_customer_id: string | null
  hubspot_company_id: string | null
  priority: 'P0' | 'P1' | 'P2'
  health_score: number | null
  churn_risk_score: number | null
  expansion_score: number | null
  mrr_cents: number | null
  plan_tier: string | null
  days_to_renewal: number | null
  trigger_reasons: string[]
  matching_playbooks: { id: string; title: string; priority: string; category: string | null }[]
}

function computeTodayActions(accounts: Account[], playbooks: Playbook[]): TodayAction[] {
  const map = new Map<string, TodayAction>()

  for (const pb of playbooks) {
    for (const acc of accounts) {
      if (!evaluateConditions(pb.eligibility_criteria, acc as any)) continue

      if (map.has(acc.id)) {
        const existing = map.get(acc.id)!
        if (!existing.matching_playbooks.some((p) => p.id === pb.id)) {
          existing.matching_playbooks.push({
            id: pb.id, title: pb.title,
            priority: pb.priority, category: pb.template_category,
          })
        }
      } else {
        const dtr = computeDaysToRenewal(acc.contract_end_date, acc.billing_interval)
        map.set(acc.id, {
          account_id: acc.id,
          stripe_customer_id: acc.stripe_customer_id,
          hubspot_company_id: acc.hubspot_company_id,
          priority: computePriority(acc.churn_risk_score, dtr),
          health_score: acc.health_score,
          churn_risk_score: acc.churn_risk_score,
          expansion_score: acc.expansion_score,
          mrr_cents: acc.mrr_cents,
          plan_tier: acc.plan_tier,
          days_to_renewal: dtr,
          trigger_reasons: computeTriggerReasons(acc),
          matching_playbooks: [{
            id: pb.id, title: pb.title,
            priority: pb.priority, category: pb.template_category,
          }],
        })
      }
    }
  }

  return Array.from(map.values())
}
```

---

## Summary (regroupement)

```typescript
interface TodayActionsSummary {
  total: number
  by_priority: { P0: number; P1: number; P2: number }
  by_category: Record<string, number>
  mrr_at_risk_cents: number  // sum MRR of P0 + P1 actions
  actions: TodayAction[]     // sorted P0 > P1 > P2, MRR desc within priority
}
```

---

## Comportement UX

### Groupes collapsibles
- **P0 (Critiques)** : ouvert par defaut, top 5 affiches, rouge
- **P1 (Hautes)** : ouvert par defaut, top 5 affiches, orange/amber
- **P2 (Normales)** : ferme par defaut, cliquer pour ouvrir, bleu

### "Voir tout" par groupe
- Si un groupe a > 5 actions, afficher "Voir les N restants" en bas
- Cliquer bascule vers la vue complete (toutes les lignes du groupe)
- Le bouton devient "Replier" une fois ouvert

### Header contextuel
```
Bonjour {userName} — {jour de la semaine} {date complète}
{total} actions prioritaires aujourd'hui
```

### Export
- Bouton "Exporter CSV" en bas de page → utilise l'Edge Function `export-playbook-accounts`
- Le frontend doit passer le JWT dans le header Authorization
- URL : `${NEXT_PUBLIC_SUPABASE_URL}/functions/v1/export-playbook-accounts`
- Body JSON : `{ playbook_id: "...", format: "csv" }` (ou sans playbook_id pour exporter toutes les actions)

### Empty state
Si 0 actions :
- Icone : CheckCircle (vert)
- Titre : "Aucune action prioritaire aujourd'hui"
- Description : "Tous vos comptes sont en bonne sante. Revenez demain ou consultez la vue d'ensemble."
- CTA : "Voir la vue d'ensemble" → `/dashboard`

---

## Labels et couleurs

### Priorites

| Priorite | Label | Couleur fond | Couleur texte | Couleur badge |
|----------|-------|-------------|---------------|---------------|
| P0 | Critique | bg-red-50 | text-red-700 | bg-red-500 |
| P1 | Haute | bg-amber-50 | text-amber-700 | bg-amber-500 |
| P2 | Normale | bg-blue-50 | text-blue-700 | bg-blue-500 |

### Categories de playbook

| Categorie | Label FR |
|-----------|----------|
| churn_prevention | Prevention churn |
| expansion | Expansion |
| onboarding | Onboarding |
| reactivation | Reactivation |
| renewal | Renouvellement |
| winback | Recuperation |
| payment_recovery | Recouvrement |
| health_monitoring | Suivi sante |

---

## Dependances

- `lucide-react` — icones (CalendarCheck, AlertTriangle, AlertCircle, Info, CreditCard, ChevronDown, ChevronRight, Filter, Download, CheckCircle)
- `ScoreBadge` — composant existant pour afficher les scores colores
- `SEGMENT_FILTERS` — filtres de segment in-memory (existant dans `segment-queries.ts`)
- `formatMrr` — formatter MRR centimes → euros (existant)

---

## Points d'attention

1. **Performance** : un seul fetch `accounts` + un fetch `playbook-crud`. Tout le matching est fait in-memory cote client. Avec 10 000 comptes et 9 playbooks, c'est quasi instantane.

2. **Deduplication** : un compte qui matche 3 playbooks = 1 seule ligne dans le tableau (pas 3). Les playbooks matchants sont listes dans la colonne "Playbooks".

3. **Tri** : P0 en haut (MRR desc), puis P1 (MRR desc), puis P2 (MRR desc). C'est le tri par defaut, non configurable.

4. **Filtres** : s'appliquent AVANT le groupement. Si on filtre par P0, seule la section P0 apparait.

5. **Badge sidebar** : le count dans le badge doit etre coherent avec le total affiche sur la page. Idealement, le count est calcule une fois dans le layout et passe a la Sidebar.

6. **Zero-PII** : comme partout, uniquement `stripe_customer_id` et `hubspot_company_id`. Pas de nom, email, telephone.

7. **Playbooks filtres** : inclure les playbooks `draft`, `active` et `paused`. Seuls les `archived` sont exclus (`status !== 'archived'`). Les 9 templates par defaut sont en `draft` — les exclure donnerait 0 actions.

8. **Rafraichissement** : le bouton "Actualiser" existant (RefreshDataButton) doit aussi rafraichir la page Aujourd'hui.
