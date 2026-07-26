# Contract: Mise en œuvre technique du pricing (backend)

## `GET /pricing-status`

**Auth**: Bearer JWT (ES256), scoping `organization_id`.

**Réponse (200)** :
```json
{
  "plan_tier": "growth",
  "active_accounts_count": 340,
  "max_active_accounts": 500,
  "usage_pct": 68,
  "alert_active": false,
  "requires_appointment": false
}
```

`max_active_accounts: null` pour Enterprise (illimité).

---

## `POST /sentio-billing/subscribe`

**Auth**: Bearer JWT (ES256). **Autorisé uniquement pour `plan_tier IN ('free', 'growth')`** — FR-012 : aucune route self-serve de finalisation pour Scale/Enterprise (l'appel retourne `403` avec message explicite invitant au RDV si tenté sur ces paliers).

**Body** : `{ "target_plan_tier": "growth" }`

**Effet** : crée (ou met à jour) le client Stripe **du compte de facturation Sentio** et l'abonnement associé (`sentio_subscriptions`), retourne l'URL de session Stripe Checkout ou Billing Portal selon le cas (création vs changement).

**Erreurs** :
- `403` — palier cible `scale`/`enterprise` (RDV obligatoire, pas de self-serve).
- `409` — downgrade demandé alors que `active_accounts_count` dépasse la limite du palier cible (FR-013).

---

## `POST /sentio-billing-webhook`

**Auth**: vérification de signature Stripe dédiée (nouveau secret, distinct de `STRIPE_WEBHOOK_SECRET` existant). **Jamais** le même endpoint ni le même secret que `stripe-webhook` existant (cf. research.md, risque critique).

**Événements traités** : `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed` — **du compte Stripe de Sentio**, pas de celui des clients de l'organisation.

**Effet** : met à jour `sentio_subscriptions.status`/`plan_tier`/`current_period_end` en cohérence.

---

## Extension : `GET /onboarding-status`

**Modification (ajout ciblé, pas de réécriture)** : nouveau champ dans la réponse existante.

```json
{
  "...": "champs existants inchangés",
  "show_call_prompt": true
}
```

`show_call_prompt = true` uniquement lorsque `stripe_connected` vient de passer à `true` pour une organisation `plan_tier IN ('free', 'growth')` — non-bloquant, le frontend décide de l'affichage, `current_step` progresse indépendamment (FR-011).

---

## Note de séparation stricte (rappel)

Aucun des endpoints ci-dessus ne doit partager de code, de secret, ou de handler avec `stripe-oauth-initiate`, `stripe-oauth-callback`, `verify-stripe-token`, `stripe-webhook`, `sync-stripe` (intégration Stripe **des clients de l'organisation**). Toute mutualisation de code doit se limiter au SDK Stripe générique, jamais aux identifiants ou aux handlers métier.
