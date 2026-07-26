# Stripe Billing (facturation Sentio) — checklist de mise en place manuelle

Ce document liste **précisément ce qui doit être créé manuellement** (hors de ce repo,
hors de toute session Claude Code) avant que `/speckit-implement` du chantier
`specs/003-pricing-billing-implementation/` puisse fonctionner de bout en bout.

> ⚠️ **Ne pas confondre avec l'intégration Stripe existante** (`stripe-oauth-initiate`,
> `stripe-oauth-callback`, `verify-stripe-token`, `stripe-webhook`, `sync-stripe`,
> variables `STRIPE_SECRET_KEY`/`STRIPE_CLIENT_ID`/`STRIPE_WEBHOOK_SECRET`). Cette
> intégration existante sert à **lire les données de facturation des clients de
> chaque organisation** — elle n'est jamais concernée par ce document. Le compte
> Stripe décrit ci-dessous est un compte **totalement séparé**, dédié à la
> facturation de Sentio auprès de ses propres organisations clientes.

## 1. Créer un compte Stripe dédié à la facturation Sentio

- Un compte Stripe **distinct** du (ou des) compte(s) Stripe déjà connectés via OAuth par les organisations clientes.
- Si un compte Stripe "Sentio" existe déjà pour un autre usage (ex. paiement de vos propres fournisseurs), **ne pas le réutiliser** — créer un compte séparé ou, à défaut, un environnement/mode clairement isolé (ex. compte connecté dédié) pour éviter tout mélange d'événements webhook entre les deux domaines.

## 2. Créer les produits et prix Stripe pour la grille tarifaire

Grille finale (confirmée 2026-07-26) : **Free / Growth / Scale / Enterprise**.

- `Free` : généralement pas de prix Stripe (palier gratuit, pas d'abonnement Stripe créé — `sentio_subscriptions.sentio_stripe_subscription_id = NULL`).
- `Growth` : un produit Stripe + un prix récurrent (mensuel, et annuel si vous proposez une remise annuelle).
- `Scale` : idem — mais rappel : ce palier n'a **aucun chemin self-serve** (FR-012), la création de l'abonnement se fera manuellement ou via un flux interne après RDV, pas via `POST /sentio-billing/subscribe`.
- `Enterprise` : idem Scale — généralement facturation sur devis, un prix Stripe "custom" peut suffire ou une gestion hors Stripe Billing standard (à votre appréciation, hors scope technique de ce chantier).

Notez les `price_id` Stripe créés — ils seront référencés dans la logique applicative (`sentio-billing-subscribe`) pour associer un palier à un prix Stripe.

## 3. Créer des clés API **restreintes** (Restricted API keys)

Ne pas utiliser la clé secrète complète du compte. Créer une **clé restreinte** dans Stripe Dashboard → Developers → API keys → "Create restricted key", avec au minimum :

| Ressource Stripe | Permission requise |
|---|---|
| Customers | Write |
| Subscriptions | Write |
| Checkout Sessions | Write |
| Billing Portal | Write |
| Webhook Endpoints | (lecture non nécessaire côté clé secrète — configuré séparément, voir §4) |

Toute ressource non listée ci-dessus : **None**.

## 4. Créer l'endpoint webhook Stripe dédié

Dans Stripe Dashboard (du compte Sentio Billing) → Developers → Webhooks → "Add endpoint" :

- **URL** : `https://<votre-projet>.supabase.co/functions/v1/sentio-billing-webhook`
- **Événements à écouter** (minimum, cf. `contracts/pricing-billing-api.md`) :
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_failed`
- Copier le **Signing secret** généré par Stripe pour cet endpoint — c'est la valeur de `STRIPE_BILLING_WEBHOOK_SECRET` (§5).

## 5. Configurer les secrets dans Supabase (Vault / variables d'environnement des Edge Functions)

Ajouter, via `supabase secrets set` ou l'interface Supabase (jamais en dur dans le code) :

| Variable | Source |
|---|---|
| `STRIPE_BILLING_SECRET_KEY` | Clé restreinte créée en §3 |
| `STRIPE_BILLING_WEBHOOK_SECRET` | Signing secret de l'endpoint créé en §4 |

**Règle de code (déjà actée dans plan.md)** : l'absence de l'une de ces deux variables au démarrage d'une fonction `sentio-billing-*` DOIT lever une erreur explicite — **jamais** de fallback silencieux vers `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` (les secrets de l'intégration client existante).

## 6. Vérification avant `/speckit-implement`

- [ ] Compte Stripe Sentio Billing créé, distinct de tout compte client.
- [ ] Produits/prix créés pour Growth (et Scale/Enterprise si applicable).
- [ ] Clé API restreinte créée (pas la clé secrète complète du compte).
- [ ] Endpoint webhook créé, événements sélectionnés, signing secret récupéré.
- [ ] `STRIPE_BILLING_SECRET_KEY` et `STRIPE_BILLING_WEBHOOK_SECRET` configurés dans Supabase.
- [ ] Confirmation qu'aucune de ces deux variables ne porte le même nom ni la même valeur que `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`.

Tant que cette checklist n'est pas complète, les tests d'intégration bout-en-bout de `sentio-billing-subscribe`/`sentio-billing-webhook` ne pourront pas s'exécuter contre un vrai compte Stripe (les tests unitaires purs, eux, ne dépendent pas de ces secrets).
