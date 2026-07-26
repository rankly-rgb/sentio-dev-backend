# Data Model: Playbooks actionnables — export CSV & bibliothèque de templates

## Entité : `playbook_message_templates` (nouvelle table)

| Colonne | Type | Contraintes |
|---------|------|-------------|
| `id` | `uuid` | PK, `default gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL, FK → `organizations.id` ON DELETE CASCADE, RLS scoping |
| `template_category` | `text` | NOT NULL, CHECK dans `VALID_TEMPLATE_CATEGORIES` (`churn_prevention`, `expansion`, `renewal`, `payment_recovery`, `reactivation`) |
| `name` | `text` | NOT NULL — nom d'affichage produit (ex: "Relance impayé — J+7") |
| `body` | `text` | NOT NULL — corps du message avec merge-tags bruts (ex: `{company}`) |
| `is_active` | `boolean` | NOT NULL, `default true` |
| `is_default` | `boolean` | NOT NULL, `default false` — un seul `is_default=true` par `(organization_id, template_category)` (contrainte applicative + index unique partiel) |
| `created_at` | `timestamptz` | NOT NULL, `default now()` |
| `updated_at` | `timestamptz` | NOT NULL, `default now()` |

**RLS** : policy standard org_isolation sur `organization_id = user_organization_id()`.

**Contrainte d'unicité** : index unique partiel `(organization_id, template_category) WHERE is_default = true` — garantit la prévisibilité décrite dans les Assumptions du spec (un seul template par défaut par catégorie et par organisation).

**Relations** : pas de FK directe vers `playbooks` — l'association se fait par `template_category` correspondant à la catégorie du playbook exporté (via `playbooks.template_category` si le champ existe déjà, sinon dérivé de la métadonnée de playbook la plus proche — à confirmer contre le schéma réel de `playbooks` au moment de l'implémentation).

## Concept : Export CSV (non persisté)

Pas de nouvelle table. Résultat calculé à la demande :

| Champ (colonne CSV) | Source |
|---|---|
| `account_ref` | `accounts.stripe_customer_id` (ou `accounts.id` — à trancher en implémentation, jamais un identifiant PII) |
| `company` (dans le message résolu) | `accounts.display_name` (nom d'entreprise, non-PII) ou `hubspot_companies` |
| `mrr_at_risk_cents` | `accounts.mrr_cents` du compte concerné |
| `days_since_last_activity` | dérivé du dernier `usage_events.event_timestamp` pour le compte, ou valeur de repli si absent |
| `message` | `playbook_message_templates.body` du template actif (par défaut si plusieurs) pour la catégorie du playbook, avec merge-tags substitués |

## Entité : Merge-tag (concept, pas de table)

Table de correspondance figée dans le code (pas en base — un merge-tag n'est pas un objet géré côté produit dans ce V1) :

| Merge-tag | Source de donnée |
|---|---|
| `{company}` | `accounts.display_name` |
| `{amount_at_risk}` | `accounts.mrr_cents` formaté en devise |
| `{days_since_last_activity}` | dérivé de `usage_events` |

## Livrable documentaire : mapping merge-tags → ESP (pas une entité de données)

Fichier markdown statique, pas de table ni de modèle applicatif. Contenu attendu : tableau merge-tag interne ↔ syntaxe Brevo (`{{ contact.ATTRIBUTE }}` ou équivalent), Lemlist (`{{customVariable}}`), ActiveCampaign (`%FIELDNAME%`) — valeurs exactes à vérifier contre la documentation de chaque ESP au moment de la rédaction, pas de code.

## Validation

- `template_category` : doit appartenir à `VALID_TEMPLATE_CATEGORIES` (réutilisation stricte de la liste existante dans `_shared/playbook-engine.ts`, pas de nouvelle taxonomie).
- `body` : non vide, longueur raisonnable (à borner en implémentation, ex. 2000 caractères, cohérent avec les autres validations de contenu du produit).
- Un seul template `is_default = true` par `(organization_id, template_category)`.
