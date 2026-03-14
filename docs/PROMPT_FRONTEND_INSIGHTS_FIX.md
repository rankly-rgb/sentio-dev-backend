# Prompt Frontend — Fix Insights IA pour tous les utilisateurs

## Contexte

L'écran Insights IA (`/dashboard/insights`) ne fonctionnait pas pour les utilisateurs non-admin. Le backend a été corrigé (migration + auth callback), mais le frontend a un bug indépendant : les noms de colonnes utilisés dans la query Supabase ne correspondent pas au schéma DB.

---

## Bug à corriger — Noms de colonnes incorrects

### Problème

La query Supabase sélectionne des colonnes qui **n'existent pas** dans la table `ai_insights` :

```ts
// ❌ INCORRECT
.select('id, type, title, description, priority, status, confidence_score, impact_mrr_cents, recommended_action, created_at')
```

PostgREST retourne une **erreur 400** (column not found) → `data = null` → la page affiche toujours l'empty state "Aucun insight généré", même quand des insights existent.

### Fix

Remplacer les noms de colonnes :

| Incorrect (frontend) | Correct (DB) |
|---|---|
| `type` | `insight_type` |
| `impact_mrr_cents` | `mrr_impact_cents` |

```ts
// ✅ CORRECT
.select('id, insight_type, title, description, priority, status, confidence_score, mrr_impact_cents, recommended_action, created_at')
```

### Interface TypeScript à mettre à jour

```ts
// ❌ Avant
interface Insight {
  id: string
  type: string                    // FAUX
  title: string
  description: string | null
  priority: string
  status: string
  confidence_score: number | null
  impact_mrr_cents: number | null // FAUX
  recommended_action: string | null
  created_at: string
}

// ✅ Après
interface Insight {
  id: string
  insight_type: string            // CORRIGÉ
  title: string
  description: string | null
  priority: string
  status: string
  confidence_score: number | null
  mrr_impact_cents: number | null // CORRIGÉ
  recommended_action: string | null
  created_at: string
}
```

### Références dans le template à mettre à jour

Tous les endroits qui utilisent `insight.type` → `insight.insight_type` :

```ts
// Lookup de la config type
const typeConf = TYPE_CONFIG[insight.insight_type] ?? TYPE_CONFIG.churn_prediction

// Affichage impact MRR
{insight.mrr_impact_cents !== null && insight.mrr_impact_cents > 0 && (
  <span>Impact : {formatMrr(insight.mrr_impact_cents)}</span>
)}

// Compteur impact total
const totalImpact = insights
  .filter((i) => i.status === 'active')
  .reduce((sum, i) => sum + (i.mrr_impact_cents ?? 0), 0)
```

---

## Alternative recommandée — Utiliser l'Edge Function `insights-crud`

Au lieu de faire une query directe à la table `ai_insights` (qui dépend de RLS et peut casser si le schéma change), le frontend devrait appeler l'Edge Function `insights-crud` qui :
- Vérifie le JWT (ES256)
- Utilise le service_role pour les queries (pas de RLS à gérer côté client)
- Retourne les bons noms de colonnes
- Supporte pagination, filtres, tri

### API disponible

```ts
// Liste paginée (défaut : status=active, 20 par page)
const response = await fetch(
  `${SUPABASE_URL}/functions/v1/insights-crud?page=1&per_page=50&status=active,acknowledged`,
  {
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
  }
)
const { data, pagination } = await response.json()
// data: Insight[] (avec insight_type, mrr_impact_cents — noms corrects)
// pagination: { page, per_page, total, total_pages }

// Filtres optionnels (query params)
// - status: 'active', 'acknowledged', 'resolved', 'dismissed' (virgule-séparés)
// - insight_type: 'churn_prediction', 'expansion_opportunity', 'renewal_alert', 'payment_risk', 'usage_drop'
// - priority: 'critical', 'high', 'medium', 'low'
// - account_id: UUID
// - sort: 'created_at' (défaut), 'priority', 'confidence_score', 'mrr_impact_cents'

// Stats agrégées
const statsResponse = await fetch(
  `${SUPABASE_URL}/functions/v1/insights-crud?stats=true&organization_id=${orgId}`,
  { headers: { 'Authorization': `Bearer ${session.access_token}` } }
)
const { data: stats } = await statsResponse.json()
// stats: { total, total_mrr_impact_cents, by_type, by_priority, by_status }

// Transition de statut (PATCH)
await fetch(
  `${SUPABASE_URL}/functions/v1/insights-crud?id=${insightId}`,
  {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: 'acknowledged' }),
  }
)
// Transitions valides :
// active → acknowledged, resolved, dismissed
// acknowledged → resolved, dismissed
// resolved, dismissed → (terminal, pas de transition)
```

### Avantages de l'Edge Function vs query directe

| | Query directe | Edge Function |
|---|---|---|
| Auth | Dépend de RLS + `user_organization_id()` | JWT vérifié dans le code (ES256) |
| Schéma | Cassé si colonnes renommées | Stable (API contract) |
| Pagination | Manuelle (`.range()`) | Built-in (`page`, `per_page`) |
| Filtres | Manuels | Query params validés |
| Erreurs | Silencieuses (PostgREST 400 → `data = null`) | HTTP status explicites |

---

## Schéma DB de référence — table `ai_insights`

```sql
CREATE TABLE public.ai_insights (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  insight_type    TEXT NOT NULL,  -- churn_prediction, expansion_opportunity, renewal_alert, payment_risk, usage_drop
  title           TEXT NOT NULL,
  description     TEXT,
  recommended_action TEXT,
  priority        TEXT NOT NULL DEFAULT 'medium',  -- low, medium, high, critical
  status          TEXT NOT NULL DEFAULT 'active',  -- active, acknowledged, resolved, dismissed
  confidence_score NUMERIC(5,2),
  mrr_impact_cents INTEGER,
  source_scores   JSONB,
  ai_model_version TEXT DEFAULT 'rules-v1',
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID,
  resolved_at     TIMESTAMPTZ,
  dismissed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
```

## 5 types d'insights générés

| Type | Déclencheur | Priorité typique |
|------|-------------|-----------------|
| `churn_prediction` | `churn_risk_score >= 70` | critical/high |
| `expansion_opportunity` | `expansion_score >= 70 AND health_score >= 60` | medium |
| `renewal_alert` | Contrat expire dans < 60 jours | high |
| `payment_risk` | Factures impayées | high/critical |
| `usage_drop` | Usage score a chuté > 30% en 14 jours | medium |

---

## Critères d'acceptation

- [ ] La page Insights affiche les insights avec le bon type et l'impact MRR
- [ ] Les colonnes utilisées sont `insight_type` et `mrr_impact_cents`
- [ ] Les insights s'affichent pour tous les utilisateurs authentifiés (pas seulement admin)
- [ ] L'empty state s'affiche uniquement quand il n'y a réellement aucun insight
- [ ] Aucun PII n'est affiché (uniquement scores, MRR, types)
- [ ] `npm run build` passe sans erreur

## Fichiers à modifier

| Fichier | Action |
|---------|--------|
| Page Insights (composant principal) | Corriger `type` → `insight_type`, `impact_mrr_cents` → `mrr_impact_cents` |
| Interface/type Insight | Mettre à jour les noms de champs |
| Tout usage de `insight.type` | Remplacer par `insight.insight_type` |
| Tout usage de `insight.impact_mrr_cents` | Remplacer par `insight.mrr_impact_cents` |
