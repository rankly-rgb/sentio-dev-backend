# Prompt Frontend : Afficher les comptes "Ciblés" dynamiques sur les cartes Playbook

## Contexte

Le backend `playbook-crud` retourne maintenant un champ **`current_eligible_count`** pour chaque playbook. Ce champ représente le nombre de comptes de l'organisation qui matchent actuellement les `eligibility_criteria` du playbook. C'est un calcul dynamique (recalculé à chaque appel API), contrairement aux anciens KPIs cumulatifs `accounts_targeted`/`accounts_eligible` qui ne s'incrémentent qu'après exécution.

## Objectif

Afficher `current_eligible_count` comme valeur "Ciblés" sur chaque carte playbook, au lieu de l'ancien `accounts_targeted` (toujours à 0 pour les playbooks non exécutés).

## Réponse API actuelle

```
GET /functions/v1/playbook-crud
Authorization: Bearer <jwt>
```

Réponse :
```json
{
  "data": [
      {
            "id": "uuid",
                  "title": "Prévention churn — Comptes enterprise",
                        "status": "draft",
                              "priority": "critical",
                                    "playbook_type": "semi_automated",
                                          "template_category": "churn_prevention",
                                                "description": "...",
                                                      "eligibility_criteria": {
                                                              "operator": "AND",
                                                                      "conditions": [
                                                                                { "field": "churn_risk_score", "operator": "gte", "value": 70 },
                                                                                          { "field": "plan_tier", "operator": "in", "value": ["growth", "enterprise"] },
                                                                                                    { "field": "mrr_cents", "operator": "gte", "value": 50000 }
                                                                                                            ]
                                                                                                                  },
                                                                                                                        "accounts_targeted": 0,
                                                                                                                              "accounts_eligible": 0,
                                                                                                                                    "accounts_reached": 0,
                                                                                                                                          "accounts_converted": 0,
                                                                                                                                                "current_eligible_count": 12,
                                                                                                                                                      "execution_count": 0,
                                                                                                                                                            "last_executed_at": null,
                                                                                                                                                                  ...
                                                                                                                                                                      }
                                                                                                                                                                        ],
                                                                                                                                                                          "total": 9,
                                                                                                                                                                            "page": 1,
                                                                                                                                                                              "per_page": 20
                                                                                                                                                                              }
                                                                                                                                                                              ```

                                                                                                                                                                              ## Changements Frontend Requis

                                                                                                                                                                              ### 1. Type Playbook

                                                                                                                                                                              Ajouter le champ `current_eligible_count` au type TypeScript `Playbook` :

                                                                                                                                                                              ```typescript
                                                                                                                                                                              interface Playbook {
                                                                                                                                                                                // ... champs existants ...
                                                                                                                                                                                  current_eligible_count: number  // NOUVEAU — comptes éligibles dynamiques
                                                                                                                                                                                    accounts_targeted: number       // ancien KPI cumulatif (post-exécution)
                                                                                                                                                                                      accounts_reached: number        // ancien KPI cumulatif
                                                                                                                                                                                        accounts_converted: number      // ancien KPI cumulatif
                                                                                                                                                                                        }
                                                                                                                                                                                        ```

                                                                                                                                                                                        ### 2. Carte Playbook (PlaybookCard)

                                                                                                                                                                                        Remplacer la source de la valeur "Ciblés" :

                                                                                                                                                                                        ```diff
                                                                                                                                                                                        - <span>Ciblés : {playbook.accounts_targeted}</span>
                                                                                                                                                                                        + <span>Ciblés : {playbook.current_eligible_count}</span>
                                                                                                                                                                                        ```

                                                                                                                                                                                        ### 3. Détail Playbook (page de détail)

                                                                                                                                                                                        Le endpoint GET avec `?id=<uuid>` retourne aussi `current_eligible_count` :

                                                                                                                                                                                        ```json
                                                                                                                                                                                        {
                                                                                                                                                                                          "id": "uuid",
                                                                                                                                                                                            "title": "...",
                                                                                                                                                                                              "current_eligible_count": 12,
                                                                                                                                                                                                "execution_stats": {
                                                                                                                                                                                                    "total_executions": 0,
                                                                                                                                                                                                        "completed": 0,
                                                                                                                                                                                                            "failed": 0,
                                                                                                                                                                                                                "running": 0,
                                                                                                                                                                                                                    "pending": 0,
                                                                                                                                                                                                                        "last_executed_at": null
                                                                                                                                                                                                                          }
                                                                                                                                                                                                                          }
                                                                                                                                                                                                                          ```

                                                                                                                                                                                                                          Sur la page de détail, afficher `current_eligible_count` dans la section résumé.

                                                                                                                                                                                                                          ### 4. Sémantique des valeurs

                                                                                                                                                                                                                          | Champ | Signification | Quand utiliser |
                                                                                                                                                                                                                          |-------|---------------|----------------|
                                                                                                                                                                                                                          | `current_eligible_count` | Comptes matchant les critères **maintenant** | "Ciblés" sur la carte |
                                                                                                                                                                                                                          | `accounts_targeted` | Total cumulé de comptes ciblés par les exécutions passées | Historique/stats d'exécution |
                                                                                                                                                                                                                          | `accounts_reached` | Total cumulé de comptes avec exécution réussie | Stats d'exécution |
                                                                                                                                                                                                                          | `accounts_converted` | Total cumulé de conversions | Stats d'exécution |

                                                                                                                                                                                                                          ### 5. Cas limites

                                                                                                                                                                                                                          - **`current_eligible_count = 0`** : Aucun compte ne matche actuellement les critères → afficher "Ciblés : 0" (comportement normal, pas d'état d'erreur)
                                                                                                                                                                                                                          - **Playbook sans `eligibility_criteria`** : `current_eligible_count` = 0 (aucun critère défini = pas de ciblage automatique)
                                                                                                                                                                                                                          - **Le champ est toujours présent** dans la réponse API, pas besoin de fallback

                                                                                                                                                                                                                          ## Pas de migration, pas de nouvelle route

                                                                                                                                                                                                                          - Aucune nouvelle route API n'est nécessaire
                                                                                                                                                                                                                          - Le champ est ajouté aux réponses existantes de `playbook-crud`
                                                                                                                                                                                                                          - Aucune migration SQL n'est nécessaire (champ calculé, pas stocké)
                                                                                                                                                                                                                          