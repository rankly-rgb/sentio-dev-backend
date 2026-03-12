# SENTIO AI — Frontend Sprint 1 & 2
*Prompt pour Claude Code — Repo frontend (Next.js 14 App Router)*

---

## Contexte

Le backend Sprint 1 & 2 est terminé et déployé (721 tests, branche `feat/export-playbook-accounts`). Ce prompt couvre les changements frontend nécessaires pour consommer les nouveaux endpoints et fonctionnalités backend.

**Lis le `CLAUDE.md` du repo frontend en entier avant de commencer.**

**Règles absolues :**
- Zero-PII : jamais d'email, nom, téléphone affiché. Uniquement `stripe_customer_id`, `hubspot_company_id`, et identifiants internes
- Tous les appels API passent par le client Supabase authentifié (JWT)
- `organization_id` scopé automatiquement par RLS — ne pas le passer manuellement dans les queries frontend
- Textes UI en français

**Stack frontend :** Next.js 14 App Router, TypeScript, Tailwind CSS 3, @supabase/ssr, Lucide icons

**Composants existants réutilisables :**
- `ScoreBadge` — badges colorés (Sain/Attention/Critique)
- `EmptyState` — état vide avec icône, titre, description, CTA
- `Breadcrumbs` — fil d'Ariane
- `Sidebar` — navigation avec badge compteur

---

## TÂCHE 1 — Badge "HubSpot non synchronisé" sur la page Paramètres

### Contrat d'API backend

```typescript
// GET /functions/v1/health-check
// Authorization: Bearer <supabase_jwt> (optionnel)
//
// Réponse succès (200):
// {
//   status: "healthy" | "degraded" | "unhealthy",
//   hubspot_stale: boolean,
//   last_hubspot_sync_hours_ago: number | null,
//   ... autres champs existants
// }
//
// hubspot_stale = true si dernière sync HubSpot réussie > 48h ou jamais
// last_hubspot_sync_hours_ago = null si jamais synchronisé
```

### Fichier à modifier : `src/app/dashboard/settings/page.tsx`

**Changements :**

1. Ajouter un appel à `/functions/v1/health-check` au chargement de la page (côté serveur dans le composant RSC, ou côté client avec `useEffect`)

2. Dans la section HubSpot de la page Paramètres, afficher un badge conditionnel :
   - Si `hubspot_stale === true` et `last_hubspot_sync_hours_ago === null` :
     - Badge orange : "Jamais synchronisé"
   - Si `hubspot_stale === true` et `last_hubspot_sync_hours_ago !== null` :
     - Badge rouge : "Dernière sync il y a {N}h — données potentiellement obsolètes"
   - Si `hubspot_stale === false` :
     - Badge vert : "Synchronisé il y a {N}h"

3. Style du badge : `rounded-full px-3 py-1 text-xs font-medium` avec couleurs Tailwind :
   - Vert : `bg-green-100 text-green-800`
   - Orange : `bg-amber-100 text-amber-800`
   - Rouge : `bg-red-100 text-red-800`

**Definition of Done :** La page Paramètres affiche l'état de fraîcheur HubSpot en temps réel. Le badge se met à jour à chaque visite de la page.

---

## TÂCHE 2 — Page de détail Playbook : approve/reject pour semi_automated

### Contrats d'API backend

```typescript
// POST /functions/v1/playbook-execute
// Authorization: Bearer <supabase_jwt>
// Body: { playbook_id: string, account_ids?: string[], segment?: string }
//
// Pour semi_automated :
// Réponse (200): { execution_id: string, status: "pending_approval", accounts_count: number }
//
// Pour automated/manual :
// Réponse (200): { execution_id: string, status: "running" | "completed", accounts_count: number }

// POST /functions/v1/playbook-crud/{id}/approve-execution
// Authorization: Bearer <supabase_jwt>
// Body: { execution_id: string }
//
// Réponse (200): { execution_id: string, status: "running", accounts_count: number }
//
// Erreurs :
// 400 { error: "execution_id manquant" }
// 403 { error: "org mismatch" } ou { error: "playbook_id ne correspond pas à cette exécution" }
// 404 { error: "exécution introuvable" }
// 409 { error: "statut invalide" }  — exécution déjà completed/cancelled

// POST /functions/v1/playbook-crud/{id}/reject-execution
// Authorization: Bearer <supabase_jwt>
// Body: { execution_id: string, reason?: string }
//
// Réponse (200): { execution_id: string, status: "cancelled" }
//
// Erreurs :
// 403 { error: "org mismatch" } ou { error: "playbook_id ne correspond pas à cette exécution" }
// 404 { error: "exécution introuvable" }
// 409 { error: "statut invalide" }
```

### Fichier à créer ou modifier : `src/app/dashboard/playbooks/[id]/page.tsx`

Si cette page existe déjà, la modifier. Sinon la créer.

**Composant : Section "Exécutions en attente d'approbation"**

Visible uniquement si le playbook est `semi_automated` ET a des exécutions `pending_approval`.

1. **Query les exécutions** du playbook :
```typescript
const { data: executions } = await supabase
  .from('playbook_executions')
  .select('id, execution_status, execution_log, started_at, accounts_targeted')
  .eq('playbook_id', playbookId)
  .order('started_at', { ascending: false })
  .limit(20)
```

2. **Filtrer côté client** : `executions.filter(e => e.execution_status === 'pending_approval')`

3. **Pour chaque exécution pending_approval, afficher une carte :**
   ```
   ┌─────────────────────────────────────────────────────────┐
   │ Exécution du {date}                                     │
   │ {N} comptes ciblés                                      │
   │ Actions prévues : {liste des types d'action}             │
   │                                                          │
   │ [Approuver ✓]  [Rejeter ✗]  [Voir les comptes ▾]       │
   └─────────────────────────────────────────────────────────┘
   ```

4. **Bouton "Approuver" :**
   - Appel : `POST /functions/v1/playbook-crud/{playbookId}/approve-execution` avec body `{ execution_id }`
   - Via `supabase.functions.invoke('playbook-crud', { body: { execution_id }, method: 'POST' })` — ATTENTION : le sub-path routing nécessite peut-être un appel fetch direct au lieu de `supabase.functions.invoke`
   - Alternative recommandée : `fetch(\`${SUPABASE_URL}/functions/v1/playbook-crud/${playbookId}/approve-execution\`, { method: 'POST', headers: { Authorization: \`Bearer ${session.access_token}\`, 'Content-Type': 'application/json' }, body: JSON.stringify({ execution_id }) })`
   - Loading state pendant l'appel
   - Succès → toast/message "Exécution approuvée — {N} comptes en cours de traitement"
   - Erreur 409 → message "Cette exécution a déjà été traitée"
   - Rafraîchir la liste des exécutions

5. **Bouton "Rejeter" :**
   - Ouvre un dialog/modal avec un champ texte optionnel "Raison du rejet"
   - Appel : `POST /functions/v1/playbook-crud/{playbookId}/reject-execution` avec body `{ execution_id, reason }`
   - Succès → message "Exécution rejetée"
   - Rafraîchir la liste

6. **Section "Historique des exécutions"** (sous les pending) :
   - Tableau des 20 dernières exécutions
   - Colonnes : Date, Statut (badge coloré), Comptes ciblés, Actions
   - Statuts possibles : `pending_approval` (jaune), `running` (bleu), `completed` (vert), `failed` (rouge), `cancelled` (gris)

### Fichier à modifier : `src/app/dashboard/playbooks/page.tsx`

Sur la carte de chaque playbook dans la liste :
- Si `playbook_type === 'semi_automated'` → afficher un petit badge "Semi-auto" (bg-amber-100 text-amber-800)
- Si le playbook a des exécutions `pending_approval` → afficher un indicateur "N en attente" (cercle rouge avec nombre, comme le badge Sidebar)

**Definition of Done :** Un utilisateur peut approuver ou rejeter une exécution semi_automated directement depuis la page de détail du playbook. L'état se rafraîchit après chaque action.

---

## TÂCHE 3 — Score d'usage "À venir" dans les vues comptes

### Contrat d'API backend

```typescript
// product_usage_score: number | null
// null = usage tracker non connecté → frontend affiche "Score à venir"
// number = score calculé (0-100)
//
// usage_tracker_connected: boolean
// false = V1 (défaut) — dimension usage exclue du Health Score
```

### Fichiers à vérifier/modifier

1. **`src/app/dashboard/accounts/page.tsx`** — Liste des comptes
   - Si `product_usage_score === null` : afficher "À venir" en gris italique au lieu d'un nombre
   - Ne PAS afficher "0" ou "50"

2. **`src/app/dashboard/accounts/[id]/page.tsx`** — Détail compte
   - Section scores : si `usage_tracker_connected === false`, afficher "Score d'usage produit : À venir (tracker non connecté)" avec un tooltip explicatif
   - Si `usage_tracker_connected === true` : afficher le score normalement avec `ScoreBadge`

3. **`src/app/dashboard/segments/[segment]/page.tsx`** — Détail segment
   - Colonne "Usage" dans le tableau : même logique null → "À venir"

4. **`src/app/dashboard/page.tsx`** — Dashboard
   - Si des widgets affichent le usage score, appliquer la même logique

### Composant utilitaire suggéré

```tsx
function UsageScoreDisplay({ score, connected }: { score: number | null; connected: boolean }) {
  if (score === null || !connected) {
    return <span className="text-gray-400 italic text-sm">À venir</span>
  }
  return <ScoreBadge value={score} type="usage" />
}
```

**Definition of Done :** Aucun "0" ou "50" ne s'affiche pour le score d'usage quand le tracker n'est pas connecté. "À venir" est affiché à la place partout dans l'UI.

---

## TÂCHE 4 — Page Aujourd'hui (`/dashboard/today`)

### Contexte

Le backend a implémenté les helpers dans `_shared/today-actions-helpers.ts` :
- `computeTodayActions(accounts, playbooks)` — matche comptes vs playbooks actifs
- `buildTodayActionsSummary(actions)` — agrège par priorité P0/P1/P2
- `sortTodayActions(actions)` — tri P0 > P1 > P2, MRR desc
- `computeTriggerReasons(account)` — raisons en français

La Sidebar référence déjà `/dashboard/today` avec un badge compteur, mais la page n'existe pas.

### Fichier à créer : `src/app/dashboard/today/page.tsx`

**Architecture de la page :**

```
┌─────────────────────────────────────────────────────────────┐
│ Aujourd'hui                                    12 mars 2026 │
├─────────────────────────────────────────────────────────────┤
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐│
│ │ P0: 3    │ │ P1: 8    │ │ P2: 12   │ │ MRR à risque     ││
│ │ Critiques│ │ Élevées  │ │ Modérées │ │ 12 450 €         ││
│ └──────────┘ └──────────┘ └──────────┘ └──────────────────┘│
├─────────────────────────────────────────────────────────────┤
│ 🔴 Priorité P0 — Actions critiques (3)            [Replier]│
│ ┌───────────────────────────────────────────────────────────┐
│ │ stripe_id  │ Churn │ MRR    │ Raison           │ Action  │
│ │ cus_abc    │  84%  │ 499 €  │ Churn critique   │ Prévention│
│ │ cus_def    │  78%  │ 350 €  │ Renouvellement   │ Suivi   │
│ │ cus_ghi    │  72%  │ 200 €  │ Santé faible     │ Relance │
│ └───────────────────────────────────────────────────────────┘
│ 🟡 Priorité P1 — Actions élevées (8)              [Replier]│
│ [Top 5 affichés]                                            │
│ [Voir les 3 restantes →]                                    │
├─────────────────────────────────────────────────────────────┤
│ 🟢 Priorité P2 — Actions modérées (12)            [Déplier]│
│ [Section repliée par défaut]                                │
└─────────────────────────────────────────────────────────────┘
```

**Données nécessaires (queries Supabase) :**

```typescript
// 1. Charger les comptes de l'org
const { data: accounts } = await supabase
  .from('accounts')
  .select('id, stripe_customer_id, hubspot_company_id, plan_tier, billing_interval, mrr_cents, health_score, churn_risk_score, expansion_score, product_usage_score, contract_end_date, created_at')
  .order('mrr_cents', { ascending: false })
  .limit(10000)

// 2. Charger les playbooks actifs
const { data: playbooks } = await supabase
  .from('playbooks')
  .select('id, title, status, playbook_type, priority, template_category, eligibility_criteria, actions')
  .in('status', ['active'])
```

**Logique de matching (côté client, en reprenant la logique backend) :**

Pour chaque playbook actif, évaluer ses `eligibility_criteria` contre chaque compte :
- `eligibility_criteria` est un JSONB : `{ operator: "AND"|"OR", conditions: [{ field, operator, value }] }`
- Fields supportés : `churn_risk_score`, `health_score`, `expansion_score`, `mrr_cents`, `product_usage_score`, `plan_tier`
- Opérateurs : `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`

**Priorité des actions :**
- **P0** : `churn_risk_score >= 70` ET `days_to_renewal < 30` (contract_end_date dans moins de 30 jours)
- **P1** : `churn_risk_score >= 50` OU `days_to_renewal < 60`
- **P2** : tout le reste

**Trigger reasons (en français) :**
- `churn_risk_score >= 70` → "Risque de churn critique ({score}%)"
- `churn_risk_score >= 50` → "Risque de churn modéré ({score}%)"
- `health_score < 40` → "Santé faible ({score})"
- Days to renewal < 60 → "Renouvellement dans {N} jours"
- `expansion_score >= 70` → "Opportunité d'expansion ({score})"
- `mrr_cents === 0` → "MRR à zéro"

**Comportement des sections :**
- P0 : ouvert par défaut
- P1 : ouvert par défaut, top 5 affichés, "Voir les N restantes" pour le reste
- P2 : fermé par défaut (collapsible)

**KPI cards en haut :**
- P0 count (fond rouge/rose)
- P1 count (fond ambre)
- P2 count (fond vert)
- MRR à risque = somme MRR des comptes P0 + P1, formaté en EUR

**Lien vers le compte :**
Chaque ligne du tableau est cliquable → `/dashboard/accounts/{account_id}`

**Empty state :**
Si aucune action aujourd'hui → `EmptyState` avec icône CalendarCheck, titre "Aucune action prioritaire", description "Tous vos comptes sont en bonne santé. Revenez demain pour un nouveau briefing."

### Fichier à modifier : `src/app/dashboard/layout.tsx`

Le layout doit passer le `todayActionCount` à la Sidebar :
1. Query les comptes et playbooks actifs
2. Calculer le nombre d'actions (même logique que la page)
3. Passer `todayActionCount={count}` à `<Sidebar />`

**Alternative plus simple :** Calculer le count dans la page Today et le stocker dans un state global (React Context ou Zustand). Ou simplement requêter le count dans le layout via une query légère.

**Definition of Done :** La page `/dashboard/today` affiche les actions groupées par priorité. Le badge Sidebar affiche le nombre total d'actions. La page est fonctionnelle avec des données réelles Supabase.

---

## TÂCHE 5 — Indicateur sync Stripe mode incrémental (optionnel)

### Contexte

Le backend `sync-stripe` log maintenant `sync_mode: 'incremental' | 'full'` dans `data_syncs`. Le frontend peut afficher cette information pour la transparence.

### Fichier à modifier : `src/app/dashboard/syncs/page.tsx`

Dans le tableau des synchronisations :
- Ajouter une colonne "Mode" après la colonne existante "Statut"
- Afficher "Complet" ou "Incrémental" selon la valeur dans `data_syncs`
- Si le champ n'existe pas dans la row (anciennes syncs) → afficher "—"

**Query à modifier :**
```typescript
// Ajouter 'metadata' au select si data_syncs a un champ metadata JSONB
// Sinon, ajouter 'sync_mode' au select si c'est un champ direct
```

Vérifier dans le backend quel champ contient le `sync_mode`. Il est probablement dans un champ `metadata` JSONB ou loggé via `DataSyncLogger`. Chercher dans `sync-stripe/index.ts` comment `sync_mode` est persisté.

**Definition of Done :** La page Synchronisations affiche "Incrémental" ou "Complet" pour chaque sync Stripe.

---

## Récapitulatif des fichiers impactés

| Fichier | Tâche | Action |
|---------|-------|--------|
| `src/app/dashboard/settings/page.tsx` | 1 | Modifier — badge HubSpot stale |
| `src/app/dashboard/playbooks/[id]/page.tsx` | 2 | Créer ou modifier — approve/reject |
| `src/app/dashboard/playbooks/page.tsx` | 2 | Modifier — badge semi-auto + pending count |
| `src/app/dashboard/accounts/page.tsx` | 3 | Modifier — "À venir" pour usage score null |
| `src/app/dashboard/accounts/[id]/page.tsx` | 3 | Modifier — "À venir" + tooltip |
| `src/app/dashboard/segments/[segment]/page.tsx` | 3 | Modifier — "À venir" dans tableau |
| `src/app/dashboard/today/page.tsx` | 4 | Créer — page complète |
| `src/app/dashboard/layout.tsx` | 4 | Modifier — todayActionCount pour Sidebar |
| `src/app/dashboard/syncs/page.tsx` | 5 | Modifier — colonne mode sync |

## Ordre d'implémentation recommandé

1. **Tâche 3** (score usage "À venir") — la plus simple, 4 fichiers à modifier de manière identique
2. **Tâche 1** (badge HubSpot stale) — un seul fichier, un appel API
3. **Tâche 5** (indicateur sync mode) — un seul fichier, optionnel
4. **Tâche 2** (approve/reject playbooks) — complexe, nouveau endpoint à consommer
5. **Tâche 4** (page Aujourd'hui) — la plus lourde, page complète à créer

## Contraintes de test

Après chaque tâche :
- `npm run build` doit passer (pas d'erreur TypeScript)
- `npm run lint` doit passer
- Vérification visuelle : ouvrir la page dans le navigateur pour confirmer le rendu

## Notes pour le développeur frontend

1. **Appels aux Edge Functions avec sub-path routing** : `supabase.functions.invoke()` ne supporte pas les sub-paths. Utiliser `fetch()` direct avec le JWT :
```typescript
const { data: { session } } = await supabase.auth.getSession()
const response = await fetch(
  `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/playbook-crud/${playbookId}/approve-execution`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session?.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ execution_id }),
  }
)
```

2. **health-check** peut être appelé sans JWT (le backend accepte les appels non authentifiés pour le monitoring). Mais avec JWT c'est plus propre pour le frontend.

3. **Évaluation des conditions playbook côté client** : la logique `evaluateConditions` existe dans le backend (`_shared/playbook-engine.ts`). Pour la page Aujourd'hui, il faut la réimplémenter côté client en TypeScript pur (pas d'import Deno). Structure :
```typescript
function evaluateConditions(
  criteria: { operator: 'AND' | 'OR'; conditions: Array<{ field: string; operator: string; value: unknown }> },
  account: Record<string, unknown>
): boolean
```
Créer ce helper dans `src/lib/playbook-conditions.ts` pour réutilisation.
