# Prompt Frontend — Refonte page "Aujourd'hui" : remplacer la liste plate par un groupement par priorité

## Problème

La page "Aujourd'hui" affiche actuellement 107 cartes d'actions en liste plate. Toutes les cartes sont visuellement identiques (même score 37.5/100, même MRR 0,00 €/mois). L'utilisateur ne sait pas par où commencer. C'est inutilisable.

## Ce qu'il faut faire

**REMPLACER** le contenu de la page "Aujourd'hui" existante. Ne PAS créer une deuxième page ni un deuxième item dans la sidebar.

Concrètement :
1. Trouver la page existante qui affiche "107 actions prioritaires aujourd'hui" avec les cartes plates
2. Remplacer son contenu par l'implémentation décrite ci-dessous
3. Ne toucher à la sidebar QUE si nécessaire (modifier le href, pas ajouter un doublon)
4. Supprimer l'ancien composant de cartes plates

---

## Architecture cible

```
┌───────────────────────────────────────────────────────────────────┐
│ 📅 Aujourd'hui — mardi 10 mars 2026                              │
│ Bonjour {userName}                                                │
│ {total} actions prioritaires                                      │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────────┐             │
│ │ 8       │ │ 24      │ │ 75      │ │ 15 350 €    │             │
│ │Critiques│ │ Hautes  │ │Normales │ │ MRR à risque│             │
│ │ P0      │ │ P1      │ │ P2      │ │ (P0 + P1)  │             │
│ └─────────┘ └─────────┘ └─────────┘ └─────────────┘             │
│                                                                   │
│ [Filtres: priorité ▾  segment ▾  catégorie ▾  MRR min ▾]        │
│                                                                   │
│ ── Critiques (8) ────────────────────────── [Tout voir ▾] ────── │
│ ┌─────────────────────────────────────────────────────────────┐   │
│ │ ID Stripe     │ MRR    │ Santé │ Risque │ Raisons │ PBs   │   │
│ │ cus_xxxxx     │ 890 €  │  28   │  84    │ Churn…  │ 2     │   │
│ │ cus_yyyyy     │ 650 €  │  35   │  78    │ Santé…  │ 1     │   │
│ │ ... +3 comptes                                     [Voir]  │   │
│ └─────────────────────────────────────────────────────────────┘   │
│                                                                   │
│ ── Hautes (24) ──────────────────────────── [Tout voir ▾] ────── │
│ │ (top 5 affiches, +19 masques)                               │   │
│                                                                   │
│ ── Normales (75) ────────────────────────── [Tout voir ▾] ────── │
│ │ (ferme par defaut — cliquer pour ouvrir)                    │   │
│                                                                   │
│ [Exporter CSV]                                                    │
└───────────────────────────────────────────────────────────────────┘
```

**Si 0 actions :** afficher un empty state avec icone CheckCircle (vert), titre "Aucune action prioritaire aujourd'hui", description "Tous vos comptes sont en bonne santé. Revenez demain ou consultez la vue d'ensemble.", bouton "Voir la vue d'ensemble" → `/dashboard`.

---

## Données sources

La page a besoin de 2 fetches :

### 1. Playbooks actifs (avec eligibility_criteria)

```typescript
// Fetch via Edge Function — retourne les playbooks enrichis avec current_eligible_count
const res = await fetch(`${NEXT_PUBLIC_SUPABASE_URL}/functions/v1/playbook-crud`, {
  headers: { Authorization: `Bearer ${jwt}` },
})
const { data: playbooks } = await res.json()

// Filtrer : exclure uniquement les playbooks archivés
// Les playbooks draft + active + paused sont inclus (les 9 templates par défaut sont en draft)
const activePlaybooks = playbooks.filter((pb: any) => pb.status !== 'archived')
```

### 2. Comptes de l'organisation

```typescript
const { data: accounts } = await supabase
  .from('accounts')
  .select('*')
  .eq('organization_id', orgId)
  .limit(10000)
```

---

## Logique de matching — quels comptes matchent quels playbooks

Chaque playbook a un champ `eligibility_criteria` (JSONB) qui définit les conditions. Il faut évaluer ces conditions contre chaque compte.

### evaluateConditions (à implémenter côté frontend)

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

function evaluateConditions(
  group: ConditionGroup | null | undefined,
  account: Record<string, unknown>,
): boolean {
  if (!group || !group.conditions?.length) return true
  if (group.operator === 'OR')
    return group.conditions.some((c) => evaluateCondition(c, account))
  return group.conditions.every((c) => evaluateCondition(c, account))
}
```

---

## Logique de priorité

```typescript
function computeDaysToRenewal(
  contractEndDate: string | null,
  billingInterval: string | null,
): number | null {
  if (!contractEndDate || billingInterval === 'monthly') return null
  const end = new Date(contractEndDate)
  const diffMs = end.getTime() - Date.now()
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24))
}

function computePriority(
  churnRisk: number | null,
  daysToRenewal: number | null,
): 'P0' | 'P1' | 'P2' {
  const risk = churnRisk ?? 0
  if (risk >= 70 && daysToRenewal !== null && daysToRenewal < 30) return 'P0'
  if (risk >= 50 || (daysToRenewal !== null && daysToRenewal < 60)) return 'P1'
  return 'P2'
}
```

**Règles :**
- **P0 (Critique)** : churn_risk >= 70 ET renouvellement dans moins de 30 jours
- **P1 (Haute)** : churn_risk >= 50, OU renouvellement dans moins de 60 jours
- **P2 (Normale)** : tout le reste

---

## Logique de trigger reasons (raisons affichées par compte)

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

## Algorithme complet : comptes → actions groupées

```typescript
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

// Étape 1 : matcher comptes ↔ playbooks (dédupliquer par account_id)
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
            priority: pb.priority, category: pb.template_category ?? null,
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
            priority: pb.priority, category: pb.template_category ?? null,
          }],
        })
      }
    }
  }

  return Array.from(map.values())
}

// Étape 2 : trier (P0 en haut, MRR desc intra-priorité)
function sortTodayActions(actions: TodayAction[]): TodayAction[] {
  const order: Record<string, number> = { P0: 0, P1: 1, P2: 2 }
  return [...actions].sort((a, b) => {
    const pa = order[a.priority] ?? 3
    const pb = order[b.priority] ?? 3
    if (pa !== pb) return pa - pb
    return (b.mrr_cents ?? 0) - (a.mrr_cents ?? 0)
  })
}

// Étape 3 : résumé
interface TodayActionsSummary {
  total: number
  by_priority: { P0: number; P1: number; P2: number }
  mrr_at_risk_cents: number  // MRR cumulé des P0 + P1
  actions: TodayAction[]     // triées
}

function buildSummary(actions: TodayAction[]): TodayActionsSummary {
  const sorted = sortTodayActions(actions)
  const by_priority = { P0: 0, P1: 0, P2: 0 }
  let mrr_at_risk_cents = 0

  for (const a of sorted) {
    by_priority[a.priority]++
    if (a.priority === 'P0' || a.priority === 'P1') {
      mrr_at_risk_cents += a.mrr_cents ?? 0
    }
  }

  return { total: sorted.length, by_priority, mrr_at_risk_cents, actions: sorted }
}
```

**IMPORTANT — déduplication :** un compte qui matche 3 playbooks = 1 seule ligne dans le tableau, pas 3. Les playbooks matchants sont listés dans la colonne "Playbooks".

---

## Composants à implémenter

### 1. Page principale (remplacer la page existante)

**État local (Client Component) :**
```typescript
const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['P0', 'P1']))
const [showAll, setShowAll] = useState<Record<string, boolean>>({ P0: false, P1: false, P2: false })
const [filters, setFilters] = useState<{
  priority?: 'P0' | 'P1' | 'P2'
  segment?: string
  category?: string
  mrrMin?: number
}>({})
```

P0 et P1 ouverts par défaut. P2 fermé.

### 2. Barre de résumé (4 KPI cards)

| Carte | Valeur | Couleur fond | Couleur texte | Icône |
|-------|--------|-------------|---------------|-------|
| Critiques | by_priority.P0 | bg-red-50 | text-red-700 | AlertTriangle |
| Hautes | by_priority.P1 | bg-amber-50 | text-amber-700 | AlertCircle |
| Normales | by_priority.P2 | bg-blue-50 | text-blue-700 | Info |
| MRR à risque | formatMrr(mrr_at_risk_cents) | bg-slate-50 | text-slate-700 | CreditCard |

Chaque carte est cliquable → scroll vers la section correspondante.

### 3. Barre de filtres

Barre horizontale sous les KPI.

| Filtre | Type | Options |
|--------|------|---------|
| Priorité | Select | Toutes, Critique (P0), Haute (P1), Normale (P2) |
| Segment | Select | Champions, En expansion, Stables, À risque léger, En danger critique, Impayés, En churn, Nouveaux |
| Catégorie | Select | Prévention churn, Expansion, Onboarding, Réactivation, Renouvellement, Récupération |
| MRR minimum | Input number | Filtre comptes >= N euros (multiplier par 100 pour comparer aux centimes) |

Les filtres s'appliquent AVANT le groupement par priorité. Bouton "Réinitialiser" visible quand au moins un filtre est actif.

Pour le filtre segment, utiliser les filtres in-memory existants (`SEGMENT_FILTERS` de `segment-queries.ts`).

### 4. Section collapsible par priorité

Un composant par niveau de priorité (P0, P1, P2).

**Header :**
- Pastille colorée (rouge P0, orange P1, bleu P2)
- Label + count entre parenthèses
- MRR total du groupe
- Chevron toggle (ouvert/fermé)

**Contenu :**
- **Tableau compact** (pas de cartes — le volume est trop grand pour des cartes)
- Affiche **5 lignes max** par défaut
- Bouton "Voir les {N} restants" en bas si > 5
- Le bouton devient "Replier" quand tout est affiché

### 5. Colonnes du tableau

| Colonne | Champ | Format |
|---------|-------|--------|
| ID Stripe | stripe_customer_id | `font-mono text-xs` |
| Plan | plan_tier | capitalize |
| MRR | mrr_cents | formatMrr() en euros |
| Santé | health_score | ScoreBadge type=health (existant) |
| Risque | churn_risk_score | ScoreBadge type=churn (existant) |
| Raisons | trigger_reasons | Chips/tags compacts, max 2 visibles + "+N" |
| Playbooks | matching_playbooks.length | Nombre, avec tooltip listant les titres |
| Renouvellement | days_to_renewal | "{N}j" ou "—" si null |

Hover sur une ligne : `bg-slate-50`. Clic sur "Voir le compte" si la route existe.

---

## Labels

```typescript
const PRIORITY_CONFIG = {
  P0: { label: 'Critique',  bg: 'bg-red-50',   text: 'text-red-700',   badge: 'bg-red-500' },
  P1: { label: 'Haute',     bg: 'bg-amber-50',  text: 'text-amber-700',  badge: 'bg-amber-500' },
  P2: { label: 'Normale',   bg: 'bg-blue-50',   text: 'text-blue-700',   badge: 'bg-blue-500' },
} as const

const CATEGORY_LABELS: Record<string, string> = {
  churn_prevention: 'Prévention churn',
  expansion: 'Expansion',
  onboarding: 'Onboarding',
  reactivation: 'Réactivation',
  renewal: 'Renouvellement',
  winback: 'Récupération',
  payment_recovery: 'Recouvrement',
  health_monitoring: 'Suivi santé',
}
```

---

## Badge sidebar

La sidebar a déjà un item "Aujourd'hui". **Ne pas en ajouter un deuxième.**

Si le badge compteur n'est pas déjà implémenté, l'ajouter sur l'item existant :
- Afficher le total d'actions en rouge (arrondi, `rounded-full`)
- `99+` si > 99
- Masquer si 0

Le count doit être cohérent avec le total affiché sur la page.

---

## Export

Bouton "Exporter CSV" en bas de page. Utilise l'Edge Function existante :

```typescript
const exportCsv = async () => {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/export-playbook-accounts`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ format: 'csv' }),
    }
  )
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `actions-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}
```

---

## Formatter MRR (si pas déjà existant)

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

---

## Icônes nécessaires (lucide-react)

```typescript
import {
  CalendarCheck,    // header page
  AlertTriangle,    // KPI P0
  AlertCircle,      // KPI P1
  Info,             // KPI P2
  CreditCard,       // KPI MRR
  ChevronDown,      // section ouverte
  ChevronRight,     // section fermée
  Filter,           // barre de filtres
  Download,         // export
  CheckCircle,      // empty state
  X,                // reset filtres
} from 'lucide-react'
```

---

## Contraintes

1. **Zero-PII** : jamais d'email, nom, téléphone. Seuls `stripe_customer_id` et `hubspot_company_id` sont affichés.
2. **Performance** : 1 fetch accounts + 1 fetch playbooks. Matching in-memory. Avec 10 000 comptes et 9 playbooks, c'est instantané.
3. **Playbooks non-archivés** : filtrer `status !== 'archived'`. Les playbooks `draft`, `active` et `paused` sont inclus (les 9 templates par défaut sont en `draft`). Seuls les `archived` sont exclus.
4. **Tri fixe** : P0 > P1 > P2, MRR décroissant dans chaque groupe. Non configurable par l'utilisateur.
5. **Pas de nouvelle dépendance** : utiliser uniquement ce qui est déjà installé (lucide-react, tailwind, supabase).

---

## Résumé des fichiers à modifier

| Action | Fichier | Détail |
|--------|---------|--------|
| MODIFIER | Page "Aujourd'hui" existante | Remplacer le contenu par la nouvelle implémentation |
| CRÉER | `lib/today-actions.ts` (ou similaire) | Fonctions pures : evaluateConditions, computePriority, computeTodayActions, buildSummary |
| MODIFIER | Sidebar (si badge manquant) | Ajouter badge compteur sur l'item existant |
| SUPPRIMER | Ancien composant de cartes plates | Plus utilisé |
