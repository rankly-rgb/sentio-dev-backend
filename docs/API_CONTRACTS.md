# API Contracts — Scoring Engine V2

Contrat de payload produit par le backend (`calculate-scores`, `generate-insights`,
`churn-alert`, `weekly-digest`) pour le modèle de scoring **v2 produit**
(`model_version = 'v3'` en base — voir migration `20260725000001_scoring_engine_v3.sql`
pour la justification du décalage de nom). Ce document est la source de vérité
pour toute équipe/session consommant ces champs (frontend, exports, intégrations).

> **Règle de lecture obligatoire (S1)** : `null` signifie *donnée absente*,
> jamais *zéro* ni *neutre*. Ne jamais afficher `null` comme `0` ou comme un
> score réel. Tout champ marqué nullable ci-dessous DOIT être géré
> explicitement côté consommateur (`?? 0` sur un score est un bug, pas un fallback).

## 1. Modèle de scoring v2 — vue d'ensemble

3 dimensions Stripe-only, poids par défaut (configurables par org, voir §6) :

| Dimension | Poids défaut | Signification |
|---|---|---|
| `payment_health` | 35 | Statut factures, historique paiement, dunning |
| `revenue_dynamics` | 35 | Tendance MRR, contraction, expansion |
| `contract_renewal` | 30 | Intervalle facturation, proximité renouvellement, ancienneté |

`engagement` (HubSpot) et `product_usage` **n'existent plus dans ce modèle**.
Elles sont prévues pour un futur modèle (nommé "v3" dans la spec produit,
à ne pas confondre avec `model_version='v3'` en base qui désigne CE modèle
3-dimensions). Le frontend doit afficher "Score à venir" ou masquer ces
axes plutôt que de lire les colonnes gelées `product_usage_score` /
`engagement_score` (voir §5, deprecated).

## 2. Champs `accounts` / `score_history` — nouveaux (Scoring V2)

| Champ | Type | Nullable | Signification |
|---|---|---|---|
| `payment_health_score` | number (0-100) | **oui** | `null` = dimension `unavailable` (< 50% du poids interne dispo) |
| `revenue_dynamics_score` | number (0-100) | **oui** | idem |
| `contract_renewal_score` | number (0-100) | **oui** | idem |
| `health_score` | number (0-100) | **oui** | `null` si `health_score_status = 'insufficient'` — jamais de fallback à 0/50 |
| `health_score_status` | `'complete'\|'partial'\|'insufficient'` | non | `complete`=3 dims dispo, `partial`=1-2 manquantes, `insufficient`=couverture < 50% → `health_score` gelé à `null` |
| `health_score_max_points` | number (0-100) | non | Dénominateur réel (somme des poids des dimensions disponibles). `health_score` est TOUJOURS "points obtenus", pas un pourcentage renormalisé — comparer `health_score / health_score_max_points` pour un pourcentage honnête, jamais `health_score` seul face à un score `complete` |
| `health_score_band` | `'healthy'\|'watch'\|'at_risk'\|null` | oui | `null` si `insufficient`. Calculé sur `health_score/health_score_max_points*100` |
| `churn_risk_score` | number (0-100) | non | **Jamais null.** Score additif de signaux déterministes, indépendant de `health_score` (S5 — ne plus le traiter comme `100-health`) |
| `churn_risk_band` | `'low'\|'watch'\|'high'` | non | low 0-24, watch 25-49, high 50-100 |
| `risk_signals_triggered` | `Array<{code, label, severity, points}>` | non (peut être `[]`) | Remplace toute notion de "% de confiance" — afficher "basé sur N signaux", jamais un pourcentage de probabilité |
| `risk_signals_evaluated` | number | non | Nombre de signaux réellement évaluables (données présentes) sur les 7 du modèle |
| `expansion_score` | number (0-100) | **oui** | `null` si `expansion_score_status = 'unavailable'` |
| `expansion_score_status` | `'available'\|'unavailable'` | non | |
| `expansion_unavailable_reason` | string \| null | oui | `'seat_data_not_configured'` ou `'unlimited_plan_no_ceiling'` — afficher un message explicite, jamais un score par défaut |
| `score_breakdown` | jsonb — voir §2bis | non (peut contenir des dimensions `unavailable`) | Base de l'explicabilité (S8) : décomposition par dimension avec score, statut, poids org et détail par signal contributeur |
| `trend_30d` | `'up'\|'flat'\|'down'` | non | Calculé et **persisté au moment du scoring** (pas à la lecture) à partir du snapshot `score_history` le plus proche de J-30 (fenêtre tolérante 27-33j). `'flat'` si `health_score` courant OU J-30 indisponible — comportement de contrat, pas un défaut caché |
| `model_version` | string | non (score_history uniquement) | `'v3'` pour ce modèle ; `'v2-explicit-no-data'` pour les lignes historiques antérieures — **ne pas comparer des courbes `score_history` entre versions sans le signaler à l'utilisateur** |

### 2bis. Format de `score_breakdown`

```json
{
  "payment_health": {
    "score": 62.5,
    "status": "available",
    "weight": 35,
    "signals": [
      { "code": "invoice_status_score", "label": "Statut des factures (90j)", "weight": 0.40, "value": 40, "status": "available" },
      { "code": "payment_history_score", "label": "Historique de paiement à temps (12 mois)", "weight": 0.35, "value": null, "status": "unavailable" },
      { "code": "dunning_score", "label": "Échecs de paiement / relances (90j)", "weight": 0.25, "value": 100, "status": "available" }
    ]
  },
  "revenue_dynamics": { "score": 71.2, "status": "available", "weight": 35, "signals": ["..."] },
  "contract_renewal": { "score": 58.0, "status": "available", "weight": 30, "signals": ["..."] }
}
```

`weight` à l'intérieur de `signals[]` est le poids **interne à la dimension**
(fraction de 1.0, ex. `0.40`) — à ne pas confondre avec le `weight` au niveau
dimension (poids org sur 100, ex. `35`). Un signal `status: 'unavailable'`
a toujours `value: null`, jamais `0` — c'est la source de vérité pour
expliquer à un CSM *pourquoi* une dimension est `partial`/`unavailable`.

## 3. Champs dépréciés — gelés, ne plus afficher comme "à jour"

Ces colonnes existent toujours (aucun `DROP`) mais **ne sont plus mises à
jour** par `calculate-scores` depuis le passage au modèle v2 (2026-07-25).
Elles restent figées à leur dernière valeur calculée sous l'ancien modèle
(`model_version='v2-explicit-no-data'`) :

| Champ | Statut |
|---|---|
| `accounts.product_usage_score` | Gelé — dimension retirée du modèle. Frontend : afficher "Score à venir" |
| `accounts.engagement_score` | Gelé — idem |
| `accounts.financial_score` | Gelé — remplacé par `payment_health_score` (sémantique différente, ne pas migrer 1:1) |
| `accounts.contract_score` | Gelé — remplacé par `contract_renewal_score` |
| `accounts.usage_narrative` | Gelé |
| `accounts.engagement_narrative` | Gelé |
| `ai_insights.confidence_score` | Toujours `null` sur les nouvelles lignes (S5 — règles déterministes, pas de fausse précision probabiliste). Remplacé par `ai_insights.metadata.severity` (`'CRITIQUE'\|'MAJEUR'\|'MINEUR'`) et `ai_insights.metadata.signals` (`string[]`) |
| `segment_memberships.confidence_score` | Idem, toujours `null` désormais (voir `COMMENT ON COLUMN` dans la migration) |
| `account_segments.segment_type = 'en_expansion'` | Segment retiré des critères actifs (fusionné dans `champions`, qui exige désormais `expansion_signals` actifs). La ligne reste en base mais n'accumule plus de nouveaux memberships — `account_count` figé/décroissant vers 0 |

## 4. Nouveau segment système

| `segment_type` | Critère | Notes |
|---|---|---|
| `donnees_insuffisantes` | `health_score_status = 'insufficient'` | **Ne coexiste jamais** avec un autre segment de santé pour le même compte (invariant vérifié — voir `docs/RUNBOOK.md` §7). Priorité juste après `en_churn`/`impayes` (factuels) et avant les segments basés sur `churn_risk_band` |

Priorité de segmentation v2 (décroissante, exclusif hors `nouveaux`) :
`en_churn` → `impayes` → `donnees_insuffisantes` → `en_danger_critique`
(`churn_risk_band='high'`) → `a_risque_leger` (`churn_risk_band='watch'`) →
`champions` (`health_score_band='healthy'` ET signal d'expansion actif) →
`stables` (défaut).

## 4bis. `primary_segment` (accounts-api)

Exposé par `accounts-api` sur `GET /accounts-api` (liste) et
`GET /accounts-api?id=` (détail). **Lu tel quel depuis `segment_memberships`**
— le dernier résultat écrit par `assignSegments` (cron `calculate-scores`),
jamais recalculé côté `accounts-api`. Zéro risque de divergence avec la
logique de segmentation puisque c'est littéralement sa sortie persistée,
mais léger décalage temporel possible entre deux runs du cron (accepté,
préférable à dupliquer la logique de `determineSegmentTypesV3`).

**Valeurs possibles** (exhaustif, `string | null`) :

| Valeur | Signification |
|---|---|
| `en_churn` | `mrr_cents = 0` ou subscription annulée |
| `impayes` | Facture(s) en retard actives |
| `donnees_insuffisantes` | `health_score_status = 'insufficient'` — jamais combiné avec un autre segment de santé |
| `en_danger_critique` | `churn_risk_band = 'high'` |
| `a_risque_leger` | `churn_risk_band = 'watch'` |
| `champions` | `health_score_band = 'healthy'` ET signal d'expansion actif |
| `stables` | Défaut (aucun autre critère) |
| `null` | Compte jamais encore segmenté par le cron (pas de membership actif hors `nouveaux`) — **jamais un défaut fabriqué**, absence de donnée honnête |

`en_expansion` **n'apparaît jamais** dans `primary_segment` — segment
retiré des critères actifs (fusionné dans `champions`), voir §3.
`nouveaux` n'apparaît jamais non plus dans ce champ : c'est un segment
non-exclusif (peut coexister avec n'importe quel segment de santé
ci-dessus) et n'est donc pas éligible comme "segment primaire" — il reste
consultable via le tableau `segments` complet renvoyé par `GET ?id=`.

## 5. Poids de scoring configurables par org (S11)

`organizations.scoring_weights` (jsonb) :
```json
{ "payment_health": 35, "revenue_dynamics": 35, "contract_renewal": 30 }
```
Contrainte DB : somme exactement 100, chaque poids entre 10 et 60 — **pas de
renormalisation automatique**, un `UPDATE` hors bornes est rejeté par la
CHECK constraint. Le frontend doit valider côté client avant l'appel API
pour un message d'erreur explicite plutôt qu'un 500 SQL.

## 6. Endpoints consommateurs — statut par rapport à ce contrat

| Endpoint | Champs scoring lus | Statut au 2026-07-25 (chantier 2) |
|---|---|---|
| `dashboard-api` (briefing/wins) | `health_score`, `payment_health_score`, `revenue_dynamics_score`, `contract_renewal_score` | **Mis à jour** — `dominantDimension()` compare les 3 dimensions v3 et exclut du calcul toute paire où l'une des deux valeurs est `null` (plus de `?? 50`/`?? 0`) ; retourne `main_dimension: null` si aucune dimension n'est comparable des deux côtés (au lieu d'un delta halluciné). `benchmarks` inchangé (métriques MRR portefeuille, pas des scores de compte) |
| `account-summary` | `health_score`, `health_score_status`, `payment_health_score`, `revenue_dynamics_score`, `contract_renewal_score`, `churn_risk_score`, `churn_risk_band`, `risk_signals_triggered`, `expansion_score`, `expansion_score_status` | **Mis à jour** — le prompt IA décrit explicitement un score `null` comme `"not enough data"` (jamais un chiffre halluciné) ; les anciennes sous-dimensions gelées (`financial_score`/`engagement_score`/`contract_score`/`product_usage_score`) ne sont plus envoyées au prompt |
| `accounts-api` (+ vue `accounts_with_priority`) | `health_score`, `health_score_status/band/max_points`, `trend_30d`, `churn_risk_score`, `churn_risk_band`, `risk_signals_triggered/evaluated`, `payment_health_score`, `revenue_dynamics_score`, `contract_renewal_score`, `expansion_score/status/reason`, `score_breakdown` | **Mis à jour** — `GET ?id=` expose le payload v3 complet (§2/§2bis) via `generateNarrativesV3` ; `product_usage_score`/`engagement_score` exposés sous `usage_frozen_v2`/`engagement_frozen_v2` (lecture seule, jamais recalculés). La vue `accounts_with_priority` (migration `20260725000002`) calcule désormais `priority_label` sur `churn_risk_band` (déjà calibré par construction) au lieu des seuils numériques hérités sur `churn_risk_score`. Les seuils `health_score <= 30/55` restent numériques (sémantique inchangée pour `health_score`) — recalibrage fin hors scope, voir `RUNBOOK.md` §7 |
| `export-csv` | `health_score`, `churn_risk_score`, `expansion_score` | **Déjà null-safe** (types `number \| null`, `?? ''` à l'export CSV) — aucun changement de code nécessaire |
| `playbooks-suggested` | `segment_type` (via `account_segments`/`segment_memberships`) | **Mis à jour** — règle `en_expansion → expansion` repointée sur `champions` (le segment retiré ne produit plus jamais de suggestion) |
| `weekly-digest` | `churn_risk_band` (nouveau), `mrr_cents` | **Mis à jour** — le seuil hardcodé `churn_risk_score >= 70` remplacé par `churn_risk_band === 'high'`, cohérent avec la nouvelle échelle additive |
| `churn-alert` | `churn_risk_band`, `risk_signals_triggered`, `last_churn_alert_at`, `last_alert_signals` (nouveaux) | **Réécrit** — triage S9 complet (band + cooldown 14j + bypass signal CRITIQUE) |
| `get_portfolio_snapshot` (RPC SQL) | `churn_risk_score > 70` pour `at_risk_count` | **Non mis à jour** — hors scope de ce chantier également (fonction SQL partagée par `accounts-api`/`get-today-status`, pas juste `dashboard-api`). Seuil `70` hérité de l'ancienne distribution, recalibrage séparé post-données réelles |
| `outbound-webhook-dispatch` | `trigger_churn_threshold` (config par org, comparé à `churn_risk_score`) | **Non mis à jour** — hors scope. Les orgs ayant configuré un seuil (ex. 70) sous l'ancien modèle verront probablement leurs webhooks ne plus jamais se déclencher sous le nouveau modèle additif |
| `playbook-engine` (`trigger_conditions`/`eligibility_criteria` sur `churn_risk_score`) | `churn_risk_score` (comparaisons `gte`/`lt` définies par l'utilisateur dans le playbook) | **Non mis à jour** — explicitement hors scope. Voir rapport de fin pour la liste des playbooks à auditer manuellement |

**Chantier de recalibrage restant (post-données réelles, séparé)** : `get_portfolio_snapshot` (`at_risk_count`), `outbound_webhook_dispatch.trigger_churn_threshold`, `playbook-engine.trigger_conditions`, et les seuils numériques `health_score <= 30/55` dans `accounts_with_priority`. Aucun de ces seuils n'est *incohérent* (ils utilisent toujours la bonne colonne), mais leur calibrage numérique hérité du modèle V1 n'a pas été validé contre la nouvelle distribution du modèle additif v3.

**Repo frontend — même famille de dette, non auditée en détail depuis ce repo (documentation seule, à charge du frontend)** :
- `today-actions.ts` — pattern `?? 0` sur des scores potentiellement absents (même défaut caché que S1 interdit côté backend)
- `account-detail-helpers.ts` — pattern `?? 100` sur des scores potentiellement absents
Ces deux fichiers vivent dans le repo frontend, hors de portée d'édition depuis ce repo backend — signalés ici pour que le recalibrage/nettoyage se fasse dans la même vague que les seuils backend ci-dessus plutôt que d'être oubliés séparément.

## 7. Exemple de payload `score_history` (ligne complète, modèle v2)

```json
{
  "organization_id": "uuid",
  "account_id": "uuid",
  "snapshot_date": "2026-07-25",
  "health_score": 42.32,
  "health_score_status": "partial",
  "health_score_max_points": 65,
  "health_score_band": "watch",
  "trend_30d": "down",
  "churn_risk_score": 35,
  "churn_risk_band": "watch",
  "risk_signals_triggered": [
    { "code": "invoice_overdue_under_15d", "label": "Facture impayée depuis moins de 15 jours", "severity": "MINEUR", "points": 10 },
    { "code": "monthly_young_account", "label": "Contrat mensuel et compte de moins de 6 mois", "severity": "MAJEUR", "points": 20 },
    { "code": "..other-signal-omitted..", "label": "...", "severity": "MINEUR", "points": 5 }
  ],
  "risk_signals_evaluated": 6,
  "expansion_score": null,
  "expansion_score_status": "unavailable",
  "expansion_unavailable_reason": "seat_data_not_configured",
  "payment_health_score": null,
  "revenue_dynamics_score": 71.2,
  "contract_renewal_score": 58.0,
  "score_breakdown": {
    "payment_health": { "score": null, "status": "unavailable", "weight": 35, "signals": [
      { "code": "invoice_status_score", "label": "Statut des factures (90j)", "weight": 0.40, "value": null, "status": "unavailable" },
      { "code": "payment_history_score", "label": "Historique de paiement à temps (12 mois)", "weight": 0.35, "value": null, "status": "unavailable" },
      { "code": "dunning_score", "label": "Échecs de paiement / relances (90j)", "weight": 0.25, "value": null, "status": "unavailable" }
    ]},
    "revenue_dynamics": { "score": 71.2, "status": "available", "weight": 35, "signals": [
      { "code": "mrr_trend_score", "label": "Tendance MRR (3 mois)", "weight": 0.45, "value": 60, "status": "available" },
      { "code": "contraction_score", "label": "Contraction MRR (6 mois)", "weight": 0.35, "value": 100, "status": "available" },
      { "code": "expansion_signal_score", "label": "Signal d'expansion (6 mois)", "weight": 0.20, "value": 60, "status": "available" }
    ]},
    "contract_renewal": { "score": 58.0, "status": "available", "weight": 30, "signals": [
      { "code": "billing_interval_score", "label": "Intervalle de facturation", "weight": 0.30, "value": 55, "status": "available" },
      { "code": "renewal_proximity_score", "label": "Proximité du renouvellement", "weight": 0.40, "value": 70, "status": "available" },
      { "code": "tenure_score", "label": "Ancienneté du contrat", "weight": 0.30, "value": 40, "status": "available" }
    ]}
  },
  "mrr_cents": 49900,
  "model_version": "v3",
  "inputs_used": {
    "mrr_cents": 49900,
    "mrr_3mo_ago_cents": 45000,
    "overdue_count": 1,
    "invoices_90d": 3,
    "invoices_12mo": 11,
    "movements_6mo": 2,
    "billing_interval": "monthly",
    "contract_end_date": null,
    "contract_start_date": "2026-02-10",
    "seat_usage_pct": null
  }
}
```

Note l'exemple : `payment_health_score = null` alors même que `health_score_status = 'partial'`
(≠ `insufficient`) — c'est attendu : la dimension `payment_health` (35 pts)
est indisponible, mais `revenue_dynamics` (35) + `contract_renewal` (30) = 65 ≥ 50,
donc le composite reste calculable (`health_score_max_points: 65`, pas 100).
