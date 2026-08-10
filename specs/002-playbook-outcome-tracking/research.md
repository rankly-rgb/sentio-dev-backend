# Research: Boucle de preuve de résultat des playbooks (backend)

## Contexte existant pertinent

- `playbook_executions` (migration `20260301000005_phase4_intelligence.sql`) possède déjà `account_converted`, `conversion_type` (CHECK `renewal|expansion|reactivation|none`), `conversion_value_cents`, `converted_at`, `executed_at`. Ces colonnes couvrent déjà une bonne partie du besoin "résolution détectée" — pas de nouvelle table nécessaire pour le résultat lui-même.
- `stripe-webhook/index.ts` traite déjà `invoice.paid` via `handleInvoiceEvent()` (ligne ~519). Le pattern **fire-and-forget** existe déjà dans ce même fichier pour `invoice.payment_failed` → appel HTTP vers `playbook-executor` sans bloquer le webhook (`fetch(...).catch(...)`, log `console.warn` en cas d'échec). C'est le pattern exact à réutiliser pour la détection de résolution — pas de nouveau pipeline Stripe, uniquement un hook fire-and-forget supplémentaire après le traitement existant de `invoice.paid`.
- `_shared/cron-lock.ts`, `_shared/dlq.ts`, `_shared/slack-alert.ts` — patterns de résilience existants, réutilisables si le nouvel appel fire-and-forget doit être audité/retenté (probablement pas nécessaire pour du fire-and-forget non-critique, cohérent avec le traitement de `invoice.payment_failed` existant qui ne fait pas de retry).
- Pas de mécanisme de lien traçable / redirection existant dans le repo (`grep` sur "redirect", "click", "tracking link" ne retourne rien de pertinent côté playbooks) — nouvelle fonctionnalité complète pour US3.
- `outbound_webhook_logs` (migration `20260426000001_outbound_webhooks.sql`) est le précédent le plus proche pour une table de log Zero-PII scoping strict `organization_id` + identifiant Stripe uniquement — modèle de référence pour la nouvelle table de log de clics.

## Decision: où stocker "marqué exécuté" et la fenêtre d'attribution

- **Decision**: réutiliser `playbook_executions.executed_at` (déjà existant, déjà défini par défaut à `now()`) comme horodatage de marquage manuel plutôt que d'ajouter une nouvelle colonne redondante. Ajouter une nouvelle colonne `attribution_window_days` sur `playbooks` (configuration par playbook, valeur par défaut au niveau applicatif si NULL) et une colonne `attribution_deadline_at` sur `playbook_executions`, calculée et figée au moment du marquage exécuté (`executed_at + attribution_window_days jours`).
- **Rationale**: `executed_at` existe déjà et porte déjà la sémantique d'horodatage d'exécution — l'utiliser évite une colonne dupliquée (Anti-surengineering CLAUDE.md : pas d'abstraction/colonne sauf besoin réel). Figer `attribution_deadline_at` au moment du marquage garantit la cohérence historique retenue en Assumptions du spec (une modification ultérieure de la config du playbook ne doit pas rouvrir une fenêtre déjà écoulée pour une exécution passée).
- **Alternatives considered**: table séparée `playbook_execution_attributions` — rejetée, sur-ingénierie pour deux colonnes supplémentaires sur une table déjà dédiée à cet usage.

## Decision: détection automatique de résolution — réutilisation du webhook Stripe

- **Decision**: dans `handleInvoiceEvent` (ou immédiatement après son appel dans le `switch` du webhook, cas `invoice.paid`), ajouter un appel fire-and-forget vers une nouvelle Edge Function (ex. `playbook-outcome-detector`) suivant exactement le pattern déjà utilisé pour `invoice.payment_failed` → `playbook-executor` (fetch sans await bloquant, `.catch()` avec `console.warn` structuré, pas de retry).
- **Rationale**: FR-004 exige explicitement la réutilisation du sync Stripe existant sans nouveau pipeline. Le pattern fire-and-forget déjà en production pour un cas quasi-identique (`invoice.payment_failed`) est directement transposable et respecte FR-005 (aucune modification du comportement existant de `handleInvoiceEvent` — le hook est additif, après le traitement standard).
- **Alternatives considered**: traiter la détection en synchrone dans `handleInvoiceEvent` lui-même — rejeté, risquerait de ralentir/complexifier le traitement webhook existant et violerait l'esprit de FR-005 (isolation du changement).

## Decision: gestion du cas multi-exécutions en attente pour le même compte

- **Decision**: la nouvelle fonction de détection marque **toutes** les exécutions actives (`executed_at` non NULL, `account_converted = false`, `attribution_deadline_at > now()`) du compte concerné comme résolues (`account_converted = true`, `conversion_type` à déterminer selon le contexte disponible, `converted_at = now()`).
- **Rationale**: cohérent avec l'Assumption du spec — évite un choix arbitraire de priorité entre plusieurs playbooks légitimement actifs sur le même compte.
- **Alternatives considered**: attribuer uniquement à l'exécution la plus récente — rejeté, perdrait un signal de résultat pour d'autres playbooks actifs légitimes (ex: un playbook "payment recovery" ET un playbook "churn risk" actifs simultanément sur le même compte).

## Decision: lien traçable + log de clic

- **Decision**: nouvelle table `playbook_execution_clicks` (`id`, `organization_id`, `playbook_execution_id`, `stripe_customer_id`, `clicked_at`, `created_at`) + nouvelle Edge Function REST (ex. `GET /playbook-link/{execution_id}`) qui enregistre le clic puis répond par une redirection HTTP (302) vers une destination associée à l'exécution (ou une destination par défaut configurable — à trancher en tasks).
- **Rationale**: modèle directement dérivé de `outbound_webhook_logs` (précédent Zero-PII validé). Aucune donnée personnelle dans la table (FR-008) — uniquement des identifiants déjà non-PII (`stripe_customer_id`, `organization_id`) et une référence d'exécution.
- **Alternatives considered**: réutiliser `outbound_webhook_logs` elle-même — rejeté, sémantique différente (webhooks sortants vs clics entrants sur lien traçable), un TYPE dédié plus simple à interroger et faire évoluer sans polluer une table existante à vocation distincte.

## Resolved NEEDS CLARIFICATION

Aucun marqueur `[NEEDS CLARIFICATION]` laissé dans le spec. Deux points restent explicitement signalés comme hypothèses à confirmer en relecture humaine avant `/speckit-tasks` :
1. La valeur par défaut de 14 jours pour la fenêtre d'attribution (alignée par cohérence sur le cooldown du chantier A, pas issue du besoin original).
2. Le comportement "toutes les exécutions actives marquées résolues" en cas d'ambiguïté multi-playbook sur un même compte.
