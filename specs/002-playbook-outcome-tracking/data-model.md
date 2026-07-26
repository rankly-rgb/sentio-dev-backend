# Data Model: Boucle de preuve de résultat des playbooks (backend)

## Extension : `playbooks` (table existante)

| Colonne (nouvelle) | Type | Contraintes |
|---|---|---|
| `attribution_window_days` | `integer` | NULL autorisé (défaut applicatif 14 si NULL), CHECK `> 0` si renseigné |

## Extension : `playbook_executions` (table existante)

| Colonne (nouvelle) | Type | Contraintes |
|---|---|---|
| `attribution_deadline_at` | `timestamptz` | NULL tant que non marquée exécutée ; calculée et figée à `executed_at + attribution_window_days` au moment du marquage |
| `resolved_via` | `text` | NULL, CHECK dans `('invoice_paid_auto', 'manual')` NULL autorisé — traçabilité de l'origine de la résolution (US2 vs future extension manuelle) |

Colonnes déjà existantes réutilisées sans modification : `executed_at`, `account_converted`, `conversion_type`, `conversion_value_cents`, `converted_at`.

**Requête de sélection des exécutions "en attente d'attribution" pour un compte** (utilisée par la détection automatique) :
```
WHERE organization_id = :org
  AND account_id = :account
  AND executed_at IS NOT NULL
  AND account_converted = false
  AND attribution_deadline_at > now()
```

## Nouvelle entité : `playbook_execution_clicks`

| Colonne | Type | Contraintes |
|---|---|---|
| `id` | `uuid` | PK, `default gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL, FK → `organizations.id` ON DELETE CASCADE, RLS scoping |
| `playbook_execution_id` | `uuid` | NOT NULL, FK → `playbook_executions.id` ON DELETE CASCADE |
| `stripe_customer_id` | `text` | NOT NULL — identifiant non-PII du compte concerné |
| `clicked_at` | `timestamptz` | NOT NULL, `default now()` |
| `created_at` | `timestamptz` | NOT NULL, `default now()` |

**RLS** : policy org_isolation standard (`organization_id = user_organization_id()`).

**Zero-PII** : aucune colonne email/nom/téléphone/IP — conforme à FR-008. Modèle directement dérivé de `outbound_webhook_logs` (précédent validé dans le produit).

**Pas de déduplication** : chaque visite du lien traçable insère une nouvelle ligne (cf. spec US3, Acceptance Scenario 3 — chaque clic est un signal distinct).

## Flux de détection automatique (pas une nouvelle table, logique applicative)

```
stripe-webhook (invoice.paid, traitement existant handleInvoiceEvent — INCHANGÉ)
  └─ fire-and-forget POST → playbook-outcome-detector
       Body: { organization_id, stripe_customer_id }
       └─ SELECT account_id FROM accounts WHERE stripe_customer_id = ... AND organization_id = ...
       └─ SELECT playbook_executions en attente d'attribution (requête ci-dessus)
       └─ UPDATE playbook_executions SET account_converted = true, converted_at = now(),
            resolved_via = 'invoice_paid_auto' WHERE id IN (...)
```

## Validation

- `attribution_window_days` : entier positif si renseigné.
- `attribution_deadline_at` : jamais recalculée après écriture initiale (immuabilité applicative, pas de contrainte SQL dédiée nécessaire — simple règle d'implémentation : aucun endpoint ne doit permettre sa modification après le marquage).
- `resolved_via` : renseigné uniquement quand `account_converted = true`.
