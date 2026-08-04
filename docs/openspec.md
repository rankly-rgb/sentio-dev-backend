# OpenSpec — Méthodologie MRR Sentio

**Statut** : source de vérité n°1 (priorité 1 dans `CLAUDE.md`, prime sur tout le reste du code et de la documentation).
**Origine** : `AUDIT_LOGIQUE_METIER_STRIPE.md` (2026-08-04) a établi que ce document n'existait pas alors que `CLAUDE.md` le désignait déjà comme source de vérité — la couche de dérivation MRR n'avait donc aucune spec écrite à laquelle se comparer. Ce document comble ce vide et acte les conventions listées ci-dessous, décidées par Naima (voir prompt d'implémentation du 2026-08-04, section "Autorisation explicite").
**Portée** : uniquement la méthodologie de calcul MRR/mouvements/statut de facturation. Ne redéfinit rien des formules de Health Score / Churn Risk / Expansion Score / Segmentation déjà documentées dans `CLAUDE.md` — ce document les complète sur leurs inputs financiers.

---

## 1. Principes fondateurs

Ces deux principes, déjà actés ailleurs dans le projet (`CLAUDE.md`, section Scoring), s'appliquent identiquement à toute la couche MRR :

- **« No data ≠ neutral data »** : une donnée Stripe qu'on ne sait pas chiffrer correctement (usage-based billing, invoice-only, devise minoritaire non convertie) ne doit **jamais** produire un `0` silencieux. Elle porte un statut explicite `mrr_status = 'unavailable'`, exclue des sommes agrégées et des prédicats binaires (`isChurned` notamment).
- **Pas de renormalisation dynamique** : comme pour le Health Score composite, l'indisponibilité d'un signal ne doit jamais changer silencieusement la formule utilisée pour les autres — elle se traduit par un statut de complétude séparé, jamais par un recalcul des poids.

---

## 2. Source du MRR

**Décision actée** : `mrr_cents` = prix catalogue normalisé, **net des remises actives** (`subscription.discounts`/`coupon` appliqués), sommé sur **tous** les `items.data[]` d'une subscription (pas seulement le premier).

- Le MRR n'est **pas** dérivé des invoices. Le prorata (lignes `proration: true` sur une facture de changement de plan en cours de cycle) reste donc neutre par construction : il n'entre jamais dans le calcul, qui ne lit jamais les invoices. Ce n'est pas un oubli — c'est la conséquence documentée du choix "prix catalogue" plutôt que "facturé réellement".
- Remises : `subscription.discounts[]` (ou le champ `discount` legacy sur les subscriptions plus anciennes) est résolu et appliqué au montant avant sommation. Un coupon `duration: 'forever'` ou `'repeating'` actif réduit `mrr_cents` en continu. Un coupon `duration: 'once'` n'a par construction aucun effet sur le MRR récurrent (il ne s'applique qu'à une seule facture) — il est ignoré.
- Expiration d'un coupon `repeating` : au cycle où `subscription.discounts` ne contient plus le coupon (détecté par la différence entre l'état précédent et l'état courant sur `customer.subscription.updated`, ou par le prochain sync quotidien), le MRR remonte à son montant plein catalogue. Ce saut est enregistré comme un mouvement `expansion` — explicite, jamais silencieux.
- Credit notes / avoirs : hors périmètre de cette itération (voir §11 "Hors périmètre").

**Différence attendue vs Stripe natif** : le dashboard Stripe natif du client affiche le **facturé réel** (avec toute la variance jour-à-jour du prorata). Le MRR Sentio est une vue normalisée, lissée, qui ne bouge qu'aux changements structurels (changement de prix, remise, quantité) — un client verra donc son MRR Stripe fluctuer en cours de mois là où le MRR Sentio reste stable jusqu'au prochain changement de plan.

---

## 3. Normalisation des intervalles

**Décision actée** :

```
mrr_cents = amount_total_after_discount / durée_periode_en_mois

durée_periode_en_mois (T, durée d'une période de facturation exprimée en mois) selon interval Stripe :
  year   →  12 × interval_count
  month  →       interval_count
  week   →       interval_count / 4.345   (1 semaine ≈ 1/4.345 mois)
  day    →       interval_count / 30.437  (1 jour ≈ 1/30.437 mois)
```

Exemple hebdomadaire : `interval='week', interval_count=1` → `T = 1/4.345 ≈ 0.230` mois/période → `mrr = amount / 0.230 = amount × 4.345` (une charge hebdomadaire de $10 vaut ≈ $43.45/mois — le montant est bien multiplié, pas divisé, T étant `< 1`).

`interval_count` (ex. `interval: 'month', interval_count: 3` = trimestriel) est toujours lu — plus jamais ignoré comme dans l'ancienne implémentation dupliquée (`sync-stripe`/`stripe-webhook`, qui ne géraient que `month`/`year` avec `interval_count` implicitement traité comme 1).

**Différence attendue vs Stripe natif** : Stripe n'a pas de notion native de "MRR" — c'est un calcul propre à Sentio (comme chez tout outil MRR tiers). Un client avec des plans trimestriels/hebdomadaires verra un MRR Sentio cohérent avec ChartMogul/Baremetrics, potentiellement différent d'un calcul maison qu'il aurait fait lui-même en divisant naïvement par 1.

---

## 4. Trials

**Décision actée** : les subscriptions `status = 'trialing'` sont **exclues** du MRR confirmé (`mrr_cents`). Leur valeur catalogue normalisée est comptée séparément dans un nouveau champ `trial_mrr_cents` ("MRR en pipeline / non confirmé").

- Convention alignée sur Baremetrics/ChartMogul (les deux excluent généralement les trials du MRR officiel).
- À la conversion trial → payant (`status: 'trialing' → 'active'`), le montant bascule de `trial_mrr_cents` vers `mrr_cents` : c'est un mouvement `new`, pas un mouvement `expansion` (le compte n'était pas dans le MRR confirmé avant).
- `customer.subscription.trial_will_end` (nouvel événement routé, voir §9) ne modifie aucun champ financier — c'est un signal informatif pour les insights/playbooks futurs, hors périmètre du moteur MRR lui-même dans cette itération.

**Différence attendue vs Stripe natif** : un compte en trial actif n'apparaîtra plus dans le MRR total affiché par Sentio, alors que certains dashboards Stripe custom du client pourraient l'inclure s'ils comptent naïvement toutes les subscriptions actives+trialing. `trial_mrr_cents` permet de retrouver ce chiffre séparément si besoin.

---

## 5. Délinquence et timing du churn

**Décision actée** :

- `past_due` / `unpaid` = **compte à risque**, jamais `churned`. Le MRR de la subscription délinquente reste compté normalement dans `mrr_cents`, avec un flag `is_delinquent = true` sur le compte.
- `churned` = uniquement quand **toutes** les subscriptions du compte sont `status = 'canceled'`. Fin de la branche `mrr_cents === 0 → churned` de l'ancien `isChurned` — un compte peut avoir `mrr_cents = 0` pour d'autres raisons (invoice-only sans repli, usage-based non chiffré) sans être `churned` pour autant (voir §7, §8).
- Timing du churn : à la **date effective d'annulation** (fin de la période payée), jamais à la demande. `cancel_at_period_end = true` pose un flag `pending_cancellation = true` sur le compte/subscription — c'est un signal de risque fort, pas un mouvement `churn`. Le mouvement `churn` n'est émis qu'au moment où Stripe bascule réellement `status → 'canceled'` (webhook `customer.subscription.deleted`, ou détection au sync quotidien).
- `is_delinquent` alimente les signaux de risque **existants** du Churn Risk V2 (`invoice_overdue_15d`, `payment_failures_90d`) — il ne crée pas de nouveau signal, il rend cohérent ce qui existait déjà avec le nouveau statut MRR.

**Note produit — D-NEXT (correctif de l'intention de D1)** : ce changement modifie le comportement de `isChurned` documenté par la décision D1 du 2026-08-02 (`CLAUDE.md`, `CHANGELOG_STABILITY.md`). Il ne contredit pas l'intention de D1 ("un compte parti n'est pas à risque, il est perdu") — il la corrige : D1 visait les comptes réellement partis, mais son implémentation (`mrr_cents === 0 OR subscriptionCanceled`) capturait aussi des comptes délinquants ou en configuration Stripe non-standard qui ne sont pas partis. Voir la note dédiée dans `CLAUDE.md` à côté de D1.

**Différence attendue vs Stripe natif** : un compte `past_due` reste visible avec son MRR dans Sentio (à risque, pas disparu), alors que le dashboard MRR natif de certains outils tiers peut déjà l'avoir retiré de leur "MRR actif". C'est un choix assumé — Sentio priorise la visibilité du risque sur la pureté comptable du MRR confirmé.

---

## 6. Downgrade vers 0€

**Décision actée** : un downgrade vers un plan à `$0` avec la subscription toujours `status = 'active'` reste classé comme mouvement `churn` (cohérent avec la décision D1 pour le calcul interne), **mais** le compte porte un flag `is_zero_dollar_active = true`, distinct de `billing_model = 'invoice_only'` et de `mrr_status = 'unavailable'`, pour permettre au reporting NRR/GRR externe de l'exclure du churn "dur" si besoin (hors périmètre de calcul dans cette itération — le flag est posé, son utilisation dans une formule NRR alternative est future work).

**Différence attendue vs Stripe natif** : sans objet — Stripe n'a pas de notion de MRR, donc pas de convention à comparer ici.

---

## 7. Réactivation

**Décision actée** : la réactivation est détectée **au niveau compte**, jamais au niveau objet subscription Stripe (qui est immuable une fois `canceled` — un client qui revient obtient un nouvel objet `Subscription` avec un nouveau `stripe_sub_id`, indissociable d'un "nouveau" client sans regarder l'historique du compte).

- Un compte est réactivé si : sa nouvelle subscription passe `mrr_cents: 0 → >0` **et** ce compte porte au moins un mouvement `churn` antérieur dans son historique (`mrr_movements`).
- Cette détection est **symétrique** sur les deux chemins d'ingestion (`sync-stripe` et `stripe-webhook`) — avant cette itération, seul `stripe-webhook` tentait de détecter la réactivation (au niveau objet subscription, donc en pratique jamais atteint), et `sync-stripe` classait toujours ce cas comme `new`.

**Différence attendue vs Stripe natif** : sans objet.

---

## 8. Configurations Stripe non-standard

### 8.1 Metered / usage-based billing

**Décision actée** : jamais chiffré dans cette itération. Une subscription dont un item a `recurring.usage_type === 'metered'`, ou dont `price.unit_amount` est `null` (typiquement `billing_scheme: 'tiered'`), reçoit `mrr_status = 'unavailable'` — sur la subscription et propagé au compte si c'est sa seule subscription active. Exempté du prédicat `isChurned` (une subscription `unavailable` n'est ni `active` au sens du MRR ni `canceled`).

### 8.2 Invoice-only (`send_invoice` sans objet `Subscription`)

**Décision actée** : détecté à la synchronisation (un customer avec ≥1 invoice mais 0 subscription) → le compte reçoit `billing_model = 'invoice_only'` (au lieu du défaut `'subscription'`), `mrr_status = 'unavailable'`, exempté du prédicat `isChurned`. **Pas de MRR de repli** calculé depuis les invoices dans cette itération (voir §11, future work).

### 8.3 Subscription Schedules

Hors périmètre de calcul MRR direct dans cette itération (la phase courante d'un schedule reste un objet `Subscription` normal, donc déjà couverte). La détection de présence d'un schedule alimente uniquement `organizations.billing_profile_flags` (Phase 3, transparence onboarding) — aucun impact sur le calcul MRR lui-même.

**Différence attendue vs Stripe natif** : pour ces trois cas, Sentio affichera explicitement "Non chiffrable" plutôt qu'un chiffre — le dashboard Stripe natif du client, lui, affichera toujours un montant (facturé réellement) puisqu'il n'a pas cette notion de statut "MRR indisponible". C'est la différence la plus visible et la plus importante à expliquer en support client : Sentio choisit délibérément de ne rien afficher plutôt que d'afficher un chiffre qu'il ne peut pas garantir exact.

---

## 9. Multi-devises

**Décision actée** : **mono-devise par organisation** dans cette itération (pas de conversion cross-devises).

- La devise de l'organisation est détectée par **vote majoritaire** sur les `subscriptions` actives (pas `invoiceRows[0]` comme dans l'ancienne implémentation, qui flappait selon l'ordre de sync). Stockée sur `subscriptions.currency` (par subscription, capturé depuis `price.currency`) et `accounts.currency` (dérivée de la/les subscription(s) du compte).
- Si plus d'une devise est détectée sur l'organisation : `organizations.billing_profile_flags.multi_currency = true` est posé (Phase 3), et les comptes dont la devise **minoritaire** diverge de la devise majoritaire de l'org reçoivent `mrr_status = 'unavailable'` — ils ne sont **jamais** sommés avec les comptes de la devise majoritaire.
- Aucune somme cross-devises n'est jamais effectuée, à aucun niveau (compte, org, portfolio-metrics).

**Différence attendue vs Stripe natif** : une organisation facturant en plusieurs devises verra son MRR total Sentio **inférieur** à la somme brute (fausse) qu'elle pourrait calculer elle-même en additionnant tous ses montants Stripe sans conversion — les comptes en devise minoritaire sont explicitement exclus plutôt que faussement additionnés. La conversion multi-devises réelle est future work (voir §11).

---

## 10. Événements rétroactifs et mouvements de correction

**Décision actée** : l'historique n'est **jamais réécrit silencieusement**.

- `charge.refunded` et `credit_note.created` sont ajoutés aux événements routés du webhook Stripe. Leurs handlers mettent à jour uniquement le **statut de l'invoice** concernée (`invoices.status`, potentiellement un nouveau statut `refunded` — voir migration) — **aucun impact rétroactif** sur `mrr_movements` ou `score_history` dans cette itération. Un remboursement ne fait pas réapparaître un `churn` daté du mois du remboursement ni ne modifie le MRR historique.
- Nouveau `movement_type = 'correction'` (CHECK constraint élargie sur `mrr_movements.movement_type`), réservé exclusivement aux migrations de restatement (§ script one-shot Phase 2.4) et à de futurs recalculs manuels. **Exclu par construction du calcul NRR** (`compute-peer-benchmarks`/`dashboard-api` filtrent `movement_type != 'correction'`).
- `movement_date` = la date **effective** de l'événement Stripe (`event.created`, ou la date métier pertinente comme `cancel_at`/`canceled_at` pour un churn), jamais `new Date()` au moment du traitement applicatif. Ce changement corrige un bug distinct de la classification elle-même : avant cette itération, un mouvement traité en retard (webhook en retard, rattrapage de sync) portait la date du traitement plutôt que la date réelle de l'événement Stripe.

**Différence attendue vs Stripe natif** : sans objet directement, mais côté support — si un client demande "pourquoi mon churn de mars n'a pas bougé après mon remboursement d'avril ?", la réponse est : c'est un choix assumé (pas de réécriture silencieuse de l'historique), un vrai restatement rétroactif est future work.

---

## 10bis. Concurrence `sync-stripe` × `stripe-webhook` pendant un restatement

**Décision actée** (auto-vérification adversariale + revue de merge, 2026-08-04) : `stripe-webhook` diffère la mise à jour `accounts.mrr_cents`/la classification de mouvement pour un event reçu **uniquement pendant qu'un restatement (`restatement_mode: true`) tourne pour cet org** — jamais pendant un `sync-stripe` normal (quotidien ou déclenché manuellement sans `restatement_mode`).

**Pourquoi cette portée précise, pas plus large** : `sync-stripe` pose deux locks distincts (`_shared/cron-lock.ts`, table `cron_locks`) :
- `sync-stripe-<org_id>` — partagé entre run normal et restatement, empêche les deux de s'exécuter en même temps pour un même org (409 sur le second appelant).
- `restatement-<org_id>` — posé uniquement en `restatement_mode: true`, en plus du lock partagé ci-dessus. C'est **ce second lock** que `stripe-webhook` vérifie (`isCronLockHeld`, lecture seule) avant d'écrire `accounts.mrr_cents`/classifier un mouvement.

Un premier passage avait fait vérifier à `stripe-webhook` le lock **partagé** (`sync-stripe-<org_id>`) plutôt que le lock dédié — cela aurait différé le traitement webhook pendant N'IMPORTE QUEL `sync-stripe`, y compris les runs quotidiens normaux (TTL 300s). Un webhook Stripe est censé donner une mise à jour quasi temps réel ; le différer pendant la fenêtre d'un sync normal l'aurait fait attendre jusqu'au **prochain sync planifié** (jusqu'à 24h) avant de voir son événement reflété — une dégradation de la latence temps réel jamais actée comme un tradeoff acceptable. Corrigé avant merge pour scoper strictement au restatement, qui est un événement rare (one-shot par déploiement de moteur MRR) et déjà annoncé comme fenêtre d'indisponibilité partielle dans `docs/RUNBOOK.md`.

**Ce qui est réellement différé, et pour combien de temps** : seuls le niveau compte (`accounts.mrr_cents`/`arr_cents`) et la génération de `mrr_movements` sont différés — la ligne `subscriptions` elle-même est toujours upsertée immédiatement avec l'état Stripe le plus récent (safe, même calcul que `sync-stripe`). Fenêtre de report : la durée du restatement pour cet org, bornée par le TTL du lock `restatement-<org_id>` (600s, voir `docs/RUNBOOK.md` §"Concurrency") — en pratique la durée réelle d'un restatement one-shot, pas un TTL qu'on s'attend à voir expirer en pratique. Rien n'est perdu : le prochain `sync-stripe` normal (quotidien) relit la subscription déjà à jour et régénère le bon mouvement en comparant au véritable état pré-migration.

---

## 11. Hors périmètre de cette itération (future work)

Explicitement non implémenté maintenant, à ne pas construire dans cette passe :

- **MRR de repli depuis les invoices** pour les comptes `billing_model = 'invoice_only'` (actuellement `mrr_status = 'unavailable'` sans calcul de repli).
- **Conversion multi-devises** réelle (actuellement : détection + exclusion des comptes en devise minoritaire, pas de conversion).
- **Feature cohortes** (`cohorts`, table conservée mais marquée `-- DORMANT` en commentaire SQL — aucune décision produit prise sur si/comment la construire).
- **Réconciliation MRR périodique contre Stripe** (audit B10) — un job qui diffuserait un écart structuré entre `accounts.mrr_cents` et l'état réel Stripe, indépendamment du sync/webhook.
- **Restatement rétroactif complet de l'historique** (`score_history`/`mrr_movements` recalculés a posteriori suite à un événement rétroactif) — seule la mise à jour du statut d'invoice est implémentée dans cette itération.

---

## 12. Résumé des nouveaux champs de schéma

Voir migration `20260804000001_mrr_engine_v2_schema.sql` pour le détail SQL complet.

| Champ | Table | Sens |
|-------|-------|------|
| `mrr_status` | `accounts`, `subscriptions` | `'ok'` \| `'unavailable'` — "no data ≠ neutral data" appliqué au MRR |
| `trial_mrr_cents` | `accounts` | MRR en pipeline (trials), exclu de `mrr_cents` |
| `is_delinquent` | `accounts` | `true` si au moins une subscription `past_due`/`unpaid` |
| `pending_cancellation` | `accounts` | `true` si `cancel_at_period_end = true` sur au moins une subscription active |
| `is_zero_dollar_active` | `accounts` | `true` si downgrade vers plan $0 avec subscription toujours active |
| `billing_model` | `accounts` | `'subscription'` \| `'invoice_only'` |
| `currency` | `accounts`, `subscriptions` | devise ISO 4217 (3 lettres), vote majoritaire au niveau org |
| `interval_raw`, `interval_count` | `subscriptions` | intervalle Stripe brut (remplace le bucket `monthly`/`annual` avec perte d'information) |
| `movement_type = 'correction'` | `mrr_movements` | réservé migrations/recalculs, exclu du NRR |

---

## 13. Fonctions pures de référence

Implémentées dans `supabase/functions/_shared/mrr-engine.ts` (Phase 2.2), testées par le golden dataset `supabase/functions/_shared/mrr-engine.test-fixtures.ts` (Phase 2.1) :

- `calcSubscriptionMrrCents(sub)` → `{ mrr_cents, trial_mrr_cents, mrr_status, currency, flags }`
- `aggregateAccountMrr(subs[])` → agrégation compte, exclusion des devises minoritaires
- `classifyMovement(prevState, newState, accountHistory)` → classification unique `new`/`expansion`/`contraction`/`churn`/`reactivation`, partagée par `sync-stripe` et `stripe-webhook`

Ces fonctions sont la seule implémentation autorisée du calcul MRR — toute duplication locale (comme l'ancienne paire `sync-stripe`/`stripe-webhook`) est un bug par définition à partir de cette itération.
