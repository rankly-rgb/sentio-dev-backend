# Quickstart: Mise en œuvre technique du pricing (backend)

## Prérequis

- Compte Stripe **de test dédié à Sentio** (distinct de tout compte Stripe client utilisé pour tester `stripe-oauth`/`sync-stripe`).
- Organisation de test sur palier Growth avec un nombre de comptes actifs suivis proche de la limite configurée dans `pricing_tier_limits`.

## Scénario 1 — Alerte d'approche de limite (US1, FR-001 à FR-003)

1. Faire croître `active_accounts_count` (comptes avec `mrr_cents > 0`) d'une organisation de test jusqu'au seuil `alert_threshold_pct` de son palier.
2. `GET /pricing-status` → vérifier `alert_active: true`.
3. Faire redescendre le compte sous le seuil (ex: churn d'un compte) → vérifier `alert_active: false`.

## Scénario 2 — Gating au dépassement (US1, FR-004)

1. Dépasser `max_active_accounts` du palier de l'organisation de test.
2. Vérifier que l'ajout d'un nouveau compte suivi est bloqué avec un message explicite, sans impact sur les comptes déjà suivis.

## Scénario 3 — Cycle de vie Stripe Billing Sentio (US2, FR-005 à FR-009)

1. `POST /sentio-billing/subscribe` (`target_plan_tier: "growth"`) pour une organisation Free de test → vérifier création de `sentio_subscriptions` avec `status: active`.
2. Changer de palier (`target_plan_tier: "scale"`) → vérifier `403` (pas de self-serve pour Scale, cf. Scénario 5).
3. Simuler un événement Stripe `customer.subscription.deleted` sur le compte Stripe **de test Sentio** vers `/sentio-billing-webhook` → vérifier `sentio_subscriptions.status = canceled` et retour au palier Free.
4. Vérifier (non-régression) : aucun de ces appels n'affecte `stripe-webhook`, `sync-stripe`, ni les tables `subscriptions`/`invoices` des clients de l'organisation.

## Scénario 4 — Downgrade bloqué si incohérent (Edge Case, FR-013)

1. Organisation avec `active_accounts_count` supérieur à la limite du palier Free.
2. Tenter un downgrade vers Free via `/sentio-billing/subscribe`.
3. Vérifier `409` avec message explicite, pas de downgrade silencieux.

## Scénario 5 — Parcours self-serve Free/Growth + proposition d'appel (US3, FR-010 à FR-012)

1. Organisation Free en cours d'onboarding, avant connexion Stripe (données clients).
2. `GET /onboarding-status` → `show_call_prompt: false`.
3. Connecter la clé Stripe (flux `stripe-oauth` existant, données clients).
4. `GET /onboarding-status` → `show_call_prompt: true`, `current_step` progresse normalement (pas bloqué).
5. Poursuivre le parcours sans donner suite à la proposition d'appel → vérifier que la souscription self-serve reste possible jusqu'au bout.
6. Tenter `POST /sentio-billing/subscribe` avec `target_plan_tier: "enterprise"` → vérifier `403`, aucun chemin self-serve.

## Validation de séparation Stripe (SC-005)

Revue technique : confirmer que `sentio-billing-webhook`, les variables d'environnement de facturation Sentio, et `sentio_subscriptions` ne partagent aucun secret, endpoint, ni table avec l'intégration Stripe existante des clients de l'organisation.
