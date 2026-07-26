# Data Model: Mise en œuvre technique du pricing (backend)

## Extension : `organizations` (table existante)

| Modification | Détail |
|---|---|
| CHECK `plan_type` | Élargie de `free\|starter\|growth\|enterprise` à `free\|growth\|scale\|enterprise` — **suppression de `starter`** (à confirmer : migration de données existantes si des organisations sont déjà sur `starter`, sinon perte de cohérence). Point à trancher explicitement en tasks avant d'exécuter la migration. |

## Nouvelle entité : `pricing_tier_limits` (table de référence, statique)

| Colonne | Type | Contraintes |
|---|---|---|
| `plan_tier` | `text` | PK, valeurs `free\|growth\|scale\|enterprise` |
| `max_active_accounts` | `integer` | NULL = illimité (Enterprise), sinon `> 0` |
| `requires_appointment` | `boolean` | NOT NULL — `true` pour Scale/Enterprise |
| `alert_threshold_pct` | `integer` | NOT NULL, `default 90`, CHECK `0 < x <= 100` |
| `updated_at` | `timestamptz` | NOT NULL, `default now()` |

Pas de `organization_id` — table de référence globale, pas de RLS org-scopée (lecture publique authentifiée uniquement, écriture réservée à un rôle admin produit).

## Nouvelle entité : `sentio_subscriptions`

| Colonne | Type | Contraintes |
|---|---|---|
| `id` | `uuid` | PK, `default gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL, UNIQUE, FK → `organizations.id` ON DELETE CASCADE, RLS scoping |
| `sentio_stripe_customer_id` | `text` | NOT NULL, UNIQUE — identifiant client sur le compte Stripe **de Sentio** (jamais celui du client final) |
| `sentio_stripe_subscription_id` | `text` | NULL (NULL tant que palier Free sans abonnement payant) |
| `plan_tier` | `text` | NOT NULL, CHECK `free\|growth\|scale\|enterprise` |
| `status` | `text` | NOT NULL, CHECK `active\|past_due\|canceled\|incomplete` |
| `current_period_end` | `timestamptz` | NULL |
| `cancel_at_period_end` | `boolean` | NOT NULL, `default false` |
| `created_at` | `timestamptz` | NOT NULL, `default now()` |
| `updated_at` | `timestamptz` | NOT NULL, `default now()` |

**RLS** : policy org_isolation standard. **Nommage** : préfixe `sentio_` sur toutes les colonnes Stripe pour lever toute ambiguïté avec les tables `subscriptions`/`invoices` existantes qui décrivent les clients de l'organisation, pas Sentio lui-même (cf. research.md, risque critique).

## Concept : Comptage des comptes actifs suivis (pas de nouvelle table)

```
SELECT COUNT(*) FROM accounts
WHERE organization_id = :org AND mrr_cents > 0
```
Cohérent avec la convention déjà établie (`docs/CHANGELOG_STABILITY.md` § Today Portfolio Status v1).

## Concept : Alerte de limite (mécanisme à trancher en tasks)

Deux options ouvertes, sans décision figée dans ce plan (à trancher en `/speckit-tasks`) :
1. Réutiliser `ai_insights` avec un nouveau `insight_type` dédié (ex. `plan_limit_warning`) — cohérent avec le système d'insights déjà existant côté organisation.
2. Nouvelle notification dédiée, hors `ai_insights` (qui concerne aujourd'hui les comptes clients, pas l'organisation elle-même — collision de sens possible).

## Validation

- `sentio_subscriptions.organization_id` : UNIQUE — une organisation a au plus un abonnement Sentio actif à la fois.
- `pricing_tier_limits` : donnée de référence, pas de RLS par organisation — accès en lecture depuis toute Edge Function authentifiée.
- Aucune colonne de ce chantier ne doit être confondue avec `stripe_product_mappings` (mapping des prix Stripe **des clients** pour le calcul d'`expansion_score` — domaine totalement différent, cf. research.md).
