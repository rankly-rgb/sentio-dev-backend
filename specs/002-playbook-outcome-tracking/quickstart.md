# Quickstart: Boucle de preuve de résultat des playbooks (backend)

## Prérequis

- Un compte avec une exécution de playbook (`playbook_executions`) existante, liée à une facture Stripe en souffrance (test-mode).
- Accès service_role pour simuler l'appel fire-and-forget interne si le webhook Stripe réel n'est pas déclenché en environnement de test.

## Scénario 1 — Marquer comme exécuté (US1, FR-001 à FR-003)

1. `POST /playbook-execute/{execution_id}/mark-executed` sur une exécution non encore marquée.
2. Vérifier : `executed_at` renseigné, `attribution_deadline_at = executed_at + 14 jours` (ou la valeur configurée sur le playbook).
3. Rejouer le même appel → vérifier réponse idempotente (200, pas de nouvel horodatage).

## Scénario 2 — Détection automatique via `invoice.paid` (US2, FR-004, FR-005)

1. Marquer une exécution comme exécutée (Scénario 1) pour un compte ayant une facture en souffrance.
2. Déclencher (ou simuler) l'événement Stripe `invoice.paid` pour le `stripe_customer_id` de ce compte, dans la fenêtre d'attribution.
3. Vérifier : l'exécution est mise à jour (`account_converted = true`, `resolved_via = 'invoice_paid_auto'`, `converted_at` renseigné).
4. Vérifier (non-régression FR-005) : le traitement standard de la facture (`handleInvoiceEvent`) produit le même résultat qu'avant ce chantier pour un compte sans exécution en attente.

## Scénario 3 — Fenêtre d'attribution expirée (Edge Case)

1. Marquer une exécution comme exécutée avec une fenêtre d'attribution courte (ex. configurer `attribution_window_days = 0` ou simuler une date passée).
2. Déclencher `invoice.paid` après expiration de la fenêtre.
3. Vérifier : l'exécution n'est PAS marquée résolue automatiquement.

## Scénario 4 — Lien traçable et log de clic (US3, FR-006 à FR-008)

1. Générer/obtenir un lien traçable pour une exécution (`/playbook-link/{execution_id}`).
2. Visiter ce lien.
3. Vérifier : redirection HTTP 302 effective vers la destination prévue, une ligne créée dans `playbook_execution_clicks`.
4. Vérifier (Zero-PII) : la ligne créée ne contient que `organization_id`, `playbook_execution_id`, `stripe_customer_id`, `clicked_at`.
5. Revisiter le même lien → vérifier qu'une deuxième ligne distincte est créée (pas de déduplication).

## Validation Zero-PII globale

Pour chaque table/log créé par ce chantier (`playbook_executions` étendu, `playbook_execution_clicks`), confirmer l'absence de toute colonne email/nom/téléphone/IP — cf. `.specify/memory/constitution.md` § Zero-PII.
