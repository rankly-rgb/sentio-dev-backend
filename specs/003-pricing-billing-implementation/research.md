# Research: Mise en œuvre technique du pricing (backend)

## ⚠️ Risque critique identifié : deux intégrations Stripe distinctes, à ne jamais confondre

Le repo contient déjà une intégration Stripe complète (`stripe-oauth-initiate`, `stripe-oauth-callback`, `verify-stripe-token`, `stripe-webhook`, `sync-stripe`, variables `STRIPE_SECRET_KEY`/`STRIPE_CLIENT_ID`/`STRIPE_WEBHOOK_SECRET`), mais elle sert **exclusivement** à lire les données de facturation *des clients de chaque organisation* (leurs `accounts`, `subscriptions`, `invoices` — la matière première du scoring). C'est la connexion "clé Stripe" mentionnée dans le besoin (volet 3, moment d'affichage de la proposition d'appel).

Le nouveau besoin (volet 2) est une **deuxième intégration Stripe, sans rapport** : Sentio facture *ses propres organisations clientes* (l'équivalent d'un abonnement SaaS classique). Ces deux intégrations DOIVENT utiliser :
- des comptes Stripe distincts (celui de chaque organisation cliente vs le compte Stripe de Sentio lui-même),
- des clés/secrets distincts (variables d'environnement `STRIPE_BILLING_SECRET_KEY`, `STRIPE_BILLING_WEBHOOK_SECRET` — noms confirmés par décision produit le 2026-07-26, explicitement différents de `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` existants, sans fallback silencieux vers ces derniers),
- des Edge Functions et handlers webhook distincts (ne jamais brancher un nouveau `case` dans `stripe-webhook/index.ts` existant — ce webhook reçoit les événements du compte Stripe **du client**, pas de celui de Sentio).

**Rationale**: une confusion ici serait une faille de sécurité et de facturation critique (ex: traiter un événement `invoice.paid` d'un client comme un paiement de l'abonnement Sentio, ou exposer les clés de facturation Sentio dans un flux pensé pour l'OAuth client). C'est le risque n°1 signalé par cette recherche — SC-005 du spec en fait un critère de succès explicite.

## Contexte existant pertinent

- `organizations.plan_type` (migration `20260301000002_phase1_infrastructure.sql`) existe déjà avec CHECK `free|starter|growth|enterprise` — **ne couvre pas "scale"** et utilise `starter` au lieu de la grille demandée (Free/Growth/Scale/Enterprise). La CHECK constraint devra être élargie (`ALTER TABLE ... DROP CONSTRAINT ... ADD CONSTRAINT ...` avec les 4 valeurs exactes), pas recréée — migration additive.
- `stripe_product_mappings` (migration `20260614000001_create_stripe_product_mappings.sql`) mappe `stripe_price_id` → `plan_tier`/`seat_limit` mais dans un contexte **différent** : "seat_limit" y sert au calcul de `expansion_score` sur les comptes clients de l'organisation (sièges de leurs propres clients), pas à la facturation de Sentio. Nom trompeur si on ne lit pas le commentaire de la migration — à ne pas réutiliser pour le nouveau besoin, qui est explicitement "facturé au nombre de comptes actifs suivis, pas par siège".
- `on-user-signup/index.ts` et `create-organization-with-invitation/index.ts` lisent/écrivent déjà `plan_type: 'free'` à la création d'organisation — point d'extension naturel, pas de nouveau mécanisme de création d'organisation à inventer.
- `onboarding-status` (Edge Function existante, cf. `docs/CHANGELOG_STABILITY.md` § Onboarding Flow Backend v1) gère déjà `current_step` incluant l'étape de connexion Stripe (`stripe_connected` via `data_syncs`). C'est le point d'accroche naturel pour FR-011 (afficher la proposition d'appel "au moment de la connexion de la clé Stripe") — probablement un nouveau champ de réponse (ex. `show_call_prompt: boolean`) sur cet endpoint existant, plutôt qu'un nouveau endpoint dédié.
- Aucune notion de "comptes actifs suivis" par organisation n'existe en tant que métrique dédiée — elle est dérivable par `COUNT(*) FROM accounts WHERE organization_id = ? AND mrr_cents > 0`, cohérent avec la convention déjà utilisée pour `total_mrr_cents` (cf. `docs/CHANGELOG_STABILITY.md` § Today Portfolio Status v1 : "un compte churné a déjà `mrr_cents = 0`").
- Aucune alerte de type "approche de limite" n'existe. `SLACK_WEBHOOK_URL` (alertes monitoring internes) n'est pas le bon canal — l'alerte visée ici est destinée à l'organisation cliente elle-même, pas à l'équipe Sentio. Nécessite un mécanisme de notification produit (probablement `ai_insights` — type d'insight existant réutilisable, ou nouvelle notification dédiée — à trancher en tasks).

## Decision: nommage et emplacement de l'abonnement de facturation Sentio

- **Decision**: nouvelle table `sentio_subscriptions` (`organization_id`, `sentio_stripe_customer_id`, `sentio_stripe_subscription_id`, `plan_tier`, `status`, `current_period_end`, `cancel_at_period_end`, `created_at`, `updated_at`) — nom explicitement préfixé `sentio_` pour lever toute ambiguïté avec les données de facturation des clients de l'organisation.
- **Rationale**: aucune table existante (`stripe_product_mappings`, `subscriptions`) ne convient — `subscriptions` (sans préfixe) désigne déjà les abonnements *des clients de l'organisation* (source du MRR scoring), une collision de nom y serait dangereuse.
- **Alternatives considered**: étendre `organizations` avec des colonnes `stripe_subscription_id` directement — rejeté, mélangerait deux domaines (identité organisation vs état de facturation évolutif avec historique/webhooks), et empêcherait un futur historique de changements de palier.

## Decision: limites de palier — configuration

- **Decision**: table de référence statique `pricing_tier_limits` (`plan_tier` PK, `max_active_accounts`, `requires_appointment` boolean, `alert_threshold_pct` défaut 90) plutôt que des constantes codées en dur, pour permettre un ajustement produit sans déploiement de code.
- **Rationale**: cohérent avec le principe déjà appliqué à `stripe_product_mappings` (configuration en base plutôt qu'en dur) et avec l'anti-surengineering (une seule petite table de référence, pas de système de feature flag complexe).
- **Alternatives considered**: constantes TypeScript dans `_shared/` — plus simple mais moins aligné avec le besoin produit d'ajuster les limites sans redéploiement ; à reconsidérer si la gouvernance produit préfère un contrôle par code review systématique sur les limites de pricing (question ouverte, pas bloquante pour ce plan).

## Decision: gating au dépassement — mécanisme technique

- **Decision**: fonction pure `checkAccountLimitGate(activeAccountCount, planTier)` dans `_shared/` (ou `_shared/pricing.ts` nouveau), appelée au moment de l'ajout d'un nouveau compte suivi (ex: dans `sync-stripe` lors de la création d'un nouveau compte, ou dans le flux d'onboarding). Le gating V1 (cf. Assumptions du spec) bloque uniquement l'ajout de nouveaux comptes au-delà de la limite, sans toucher aux comptes déjà suivis.
- **Rationale**: cohérent avec le pattern `_shared/scoring.ts` déjà en place pour la logique métier pure et testable, et avec le principe "pas d'abstraction sauf réutilisée 2+ fois" — une fonction pure unique, appelée aux points d'entrée pertinents.
- **Alternatives considered**: contrainte SQL/trigger empêchant l'insertion — rejeté, la logique de gating implique une alerte progressive (seuil d'approche) et un message explicite, pas seulement un rejet binaire ; plus adapté en code applicatif.

## Decision: webhooks Stripe Billing (facturation Sentio) — nouvelle Edge Function dédiée

- **Decision**: nouvelle Edge Function `sentio-billing-webhook`, strictement séparée de `stripe-webhook` existant, avec son propre secret de vérification de signature (nouvelle variable d'environnement dédiée).
- **Rationale**: application directe du risque critique identifié plus haut — aucune mutualisation de code de traitement webhook entre les deux intégrations Stripe, même si le SDK Stripe sous-jacent est le même package.
- **Alternatives considered**: réutiliser `stripe-webhook/index.ts` avec un paramètre de route pour distinguer la source — rejeté explicitement, risque de confusion architecturale trop élevé pour un sujet de facturation.

## Decision: parcours self-serve — proposition d'appel non-bloquante

- **Decision**: extension de `onboarding-status` (champ additionnel `show_call_prompt: boolean`, vrai uniquement au moment où `stripe_connected` passe de `false` à `true` pour une organisation Free/Growth) plutôt qu'un nouvel endpoint — le frontend affiche la proposition sans bloquer `current_step`.
- **Rationale**: réutilise l'endpoint déjà consulté par le frontend à cette étape précise du parcours (cf. `docs/CHANGELOG_STABILITY.md` § Onboarding Flow Backend v1), évite un nouvel appel réseau dédié.
- **Alternatives considered**: nouvel endpoint `GET /pricing-call-prompt` — rejeté comme sur-ingénierie pour une seule valeur booléenne contextuelle à un moment déjà suivi par un endpoint existant.

## Resolved NEEDS CLARIFICATION

Aucun marqueur `[NEEDS CLARIFICATION]` laissé dans le spec. Le point le plus sensible à faire valider explicitement en relecture humaine avant `/speckit-tasks` est le risque critique en tête de ce document (séparation stricte des deux intégrations Stripe) — pas une clarification de besoin, mais une contrainte architecturale à faire confirmer avant toute tâche d'implémentation.
