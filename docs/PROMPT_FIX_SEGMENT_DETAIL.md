# Prompt Frontend — Fix Segment Detail : 0 comptes affichés

## Contexte du bug (backend corrigé)

La page détail d'un segment affichait **0 comptes** alors que la page liste des segments affichait le bon nombre (ex: "À risque léger" = 101 comptes sur la liste, 0 sur le détail).

**Cause racine (backend, corrigée)** : la table `segment_memberships` n'était pas peuplée à cause d'un mismatch `onConflict` dans `calculate-scores`. Le fix backend est déployé — le prochain run de `calculate-scores` peuplera la table correctement.

**Impact frontend** : après le prochain run de scoring, la RPC `get_segment_accounts()` retournera les bons résultats. Aucun changement frontend n'est strictement nécessaire pour que le bug soit résolu.

## Recommandation : aligner la source de données (optionnel mais recommandé)

Actuellement, deux sources de données coexistent dans le frontend :

| Écran | Source de données | Méthode |
|-------|------------------|---------|
| Liste segments (cards) | Query `accounts` + filtrage in-memory (`SEGMENT_FILTERS`) | Toujours à jour, basé sur les scores |
| Détail segment (table) | RPC `get_segment_accounts()` → JOIN `segment_memberships` | Dépend du dernier run de `calculate-scores` |

Cette dualité peut créer un décalage temporaire : un compte peut changer de segment (ses scores évoluent) mais `segment_memberships` ne sera mis à jour qu'au prochain cron de scoring.

### Option A — Ne rien changer (acceptable)

Le fix backend suffit. Les comptes apparaîtront dans le détail après le prochain scoring. Le décalage est de quelques heures max (fréquence cron).

### Option B — Aligner le détail sur le filtrage in-memory (recommandé)

Utiliser la même logique de filtrage in-memory que la page liste pour le détail. Cela garantit une cohérence parfaite entre les deux écrans.

**Modification** : dans la page détail du segment (`/dashboard/segments/[segment]/page.tsx` ou équivalent) :

1. Remplacer l'appel RPC `get_segment_accounts()` par une query directe sur `accounts` :
```typescript
const { data: accounts } = await supabase
  .from('accounts')
  .select('*')
  .eq('organization_id', orgId)
  .order('mrr_cents', { ascending: false })
  .limit(10000)
```

2. Appliquer le même filtre `SEGMENT_FILTERS[segment]` que la page liste :
```typescript
import { SEGMENT_FILTERS } from '@/lib/segment-queries' // ou l'emplacement réel

const filteredAccounts = accounts.filter(SEGMENT_FILTERS[segment])
```

3. Calculer les métriques agrégées (total comptes, MRR total, score santé moyen) à partir de `filteredAccounts` au lieu de la réponse RPC.

**Avantages** :
- Cohérence parfaite entre liste et détail (même filtre, mêmes comptes)
- Pas de dépendance au timing du cron de scoring
- L'export CSV utilise déjà cette approche (edge function `export-segment-csv`)

**Inconvénients** :
- Charge tous les comptes en mémoire (acceptable jusqu'à ~10 000 comptes)
- Perd la pagination serveur-side de la RPC (implémenter côté client si nécessaire)

### Détail des filtres de segment (source de vérité : `scoring.ts`)

```typescript
const SEGMENT_FILTERS: Record<string, (a: Account) => boolean> = {
  champions: (a) => (a.health_score ?? 0) >= 80 && (a.churn_risk_score ?? 100) < 50,
  en_expansion: (a) => (a.expansion_score ?? 0) >= 70 && (a.health_score ?? 0) >= 60 && (a.health_score ?? 0) < 80 && (a.churn_risk_score ?? 100) < 50,
  stables: (a) => (a.mrr_cents ?? 0) > 0 && (a.churn_risk_score ?? 100) < 50 && (a.health_score ?? 0) < 80 && !((a.expansion_score ?? 0) >= 70 && (a.health_score ?? 0) >= 60),
  a_risque_leger: (a) => (a.churn_risk_score ?? 0) >= 50 && (a.churn_risk_score ?? 0) < 70 && (a.mrr_cents ?? 0) > 0,
  en_danger_critique: (a) => (a.churn_risk_score ?? 0) >= 70 && (a.mrr_cents ?? 0) > 0,
  impayes: (a) => (a.churn_risk_score ?? 0) > 80 && (a.health_score ?? 0) < 50 && (a.mrr_cents ?? 0) > 0,
  en_churn: (a) => (a.mrr_cents ?? 0) === 0,
  nouveaux: (a) => {
    if (!a.created_at) return false
    const diffMs = Date.now() - new Date(a.created_at).getTime()
    return diffMs < 90 * 24 * 60 * 60 * 1000
  },
}
```

> **Important** : ces filtres doivent être identiques entre la page liste, la page détail, et l'export CSV. Si le frontend a déjà un fichier `segment-queries.ts` avec ces filtres, réutilisez-le partout.

## Action post-deploy backend

Après le déploiement du fix backend, **déclencher manuellement un run de `calculate-scores`** (ou attendre le prochain cron) pour peupler `segment_memberships`. Cela corrigera immédiatement le détail si l'Option A est choisie.

```bash
curl -X POST https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/calculate-scores \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"
```
