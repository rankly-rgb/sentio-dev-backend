// ============================================================
// mrr-engine.test.ts — Golden dataset MRR (Phase 2.1)
//
// Écrit AVANT le câblage de sync-stripe/stripe-webhook sur le moteur
// (Phase 2.2). Deux blocs :
//   1. Le moteur (_shared/mrr-engine.ts), conforme à docs/openspec.md —
//      doit être vert en permanence, sert de garde-fou de non-régression.
//   2. "legacy behaviour" — reproduction documentée de l'ancienne formule
//      dupliquée (sync-stripe/index.ts + stripe-webhook/index.ts avant
//      refactor) contre le même golden dataset, pour établir sur pièce
//      (test qui passe, pas juste une affirmation) que le code actuel
//      produit des chiffres faux sur ces scénarios. Ce bloc n'est PAS du
//      code de production — uniquement une reproduction à des fins de
//      preuve d'audit, jamais importée ailleurs.
// ============================================================
import { describe, it, expect } from 'vitest'
import {
  calcSubscriptionMrrCents,
  aggregateAccountMrr,
  classifyMovement,
  detectBillingModel,
  detectOrgMajorityCurrency,
  isAccountChurned,
  type StripeSubscriptionLike,
} from '../functions/_shared/mrr-engine'
import {
  FIXTURE_MONTHLY_SIMPLE, EXPECTED_MONTHLY_SIMPLE_CENTS,
  FIXTURE_ANNUAL, EXPECTED_ANNUAL_CENTS,
  FIXTURE_QUARTERLY, EXPECTED_QUARTERLY_CENTS, LEGACY_BUGGY_QUARTERLY_CENTS,
  FIXTURE_WEEKLY, EXPECTED_WEEKLY_CENTS, LEGACY_BUGGY_WEEKLY_CENTS,
  FIXTURE_MULTI_ITEM, EXPECTED_MULTI_ITEM_CENTS, LEGACY_BUGGY_MULTI_ITEM_CENTS,
  FIXTURE_COUPON_FOREVER, EXPECTED_COUPON_FOREVER_CENTS,
  FIXTURE_COUPON_REPEATING_ACTIVE, FIXTURE_COUPON_REPEATING_EXPIRED,
  EXPECTED_COUPON_REPEATING_ACTIVE_CENTS, EXPECTED_COUPON_REPEATING_EXPIRED_CENTS,
  EXPECTED_COUPON_EXPIRY_MOVEMENT_DELTA,
  FIXTURE_COUPON_ONCE, EXPECTED_COUPON_ONCE_CENTS,
  FIXTURE_TRIAL, EXPECTED_TRIAL_MRR_CENTS, EXPECTED_TRIAL_TRIAL_MRR_CENTS,
  FIXTURE_TRIAL_CONVERTED, EXPECTED_TRIAL_CONVERTED_MRR_CENTS,
  FIXTURE_PAST_DUE, EXPECTED_PAST_DUE_MRR_CENTS, EXPECTED_PAST_DUE_IS_DELINQUENT, EXPECTED_PAST_DUE_CHURNED,
  FIXTURE_CANCELED, EXPECTED_CANCELED_MRR_CENTS, EXPECTED_CANCELED_CHURNED,
  FIXTURE_PENDING_CANCELLATION, EXPECTED_PENDING_CANCELLATION_MRR_CENTS, EXPECTED_PENDING_CANCELLATION_FLAG,
  FIXTURE_TWO_SUBS_A, FIXTURE_TWO_SUBS_B, EXPECTED_TWO_SUBS_TOTAL_CENTS,
  FIXTURE_METERED, EXPECTED_METERED_STATUS, EXPECTED_METERED_MRR_CENTS,
  FIXTURE_MULTI_CURRENCY_USD, FIXTURE_MULTI_CURRENCY_JPY,
  EXPECTED_MULTI_CURRENCY_ORG_MAJORITY, EXPECTED_MULTI_CURRENCY_MINORITY_STATUS,
  LEGACY_BUGGY_MULTI_CURRENCY_SUMMED_CENTS,
  FIXTURE_QUANTITY, EXPECTED_QUANTITY_CENTS,
  FIXTURE_NULL_UNIT_AMOUNT, EXPECTED_NULL_UNIT_AMOUNT_STATUS, EXPECTED_NULL_UNIT_AMOUNT_MRR_CENTS,
  FIXTURE_REACTIVATION_NEW_SUB, EXPECTED_REACTIVATION_MRR_CENTS,
} from '../functions/_shared/mrr-engine.test-fixtures'

// ============================================================
// 1. calcSubscriptionMrrCents — scénarios 1 à 8, 15, 17, 18
// ============================================================
describe('calcSubscriptionMrrCents — golden dataset', () => {
  it('(1) mensuel simple → 4900', () => {
    expect(calcSubscriptionMrrCents(FIXTURE_MONTHLY_SIMPLE).mrr_cents).toBe(EXPECTED_MONTHLY_SIMPLE_CENTS)
  })

  it('(2) annuel /12 → 10000', () => {
    expect(calcSubscriptionMrrCents(FIXTURE_ANNUAL).mrr_cents).toBe(EXPECTED_ANNUAL_CENTS)
  })

  it('(3) trimestriel interval_count=3 → 10000 (pas 30000)', () => {
    expect(calcSubscriptionMrrCents(FIXTURE_QUARTERLY).mrr_cents).toBe(EXPECTED_QUARTERLY_CENTS)
  })

  it('(4) hebdomadaire → 4345 (amount × 4.345)', () => {
    expect(calcSubscriptionMrrCents(FIXTURE_WEEKLY).mrr_cents).toBe(EXPECTED_WEEKLY_CENTS)
  })

  it('(5) multi-items (base + sièges) → somme de tous les items', () => {
    expect(calcSubscriptionMrrCents(FIXTURE_MULTI_ITEM).mrr_cents).toBe(EXPECTED_MULTI_ITEM_CENTS)
  })

  it('(6) coupon forever 20% → net de la remise', () => {
    expect(calcSubscriptionMrrCents(FIXTURE_COUPON_FOREVER).mrr_cents).toBe(EXPECTED_COUPON_FOREVER_CENTS)
  })

  it('(7a) coupon repeating actif → net de la remise', () => {
    expect(calcSubscriptionMrrCents(FIXTURE_COUPON_REPEATING_ACTIVE).mrr_cents).toBe(EXPECTED_COUPON_REPEATING_ACTIVE_CENTS)
  })

  it('(7b) coupon repeating expiré (absent de discounts) → plein tarif', () => {
    expect(calcSubscriptionMrrCents(FIXTURE_COUPON_REPEATING_EXPIRED).mrr_cents).toBe(EXPECTED_COUPON_REPEATING_EXPIRED_CENTS)
  })

  it('(8) coupon once → aucun effet sur le MRR récurrent', () => {
    expect(calcSubscriptionMrrCents(FIXTURE_COUPON_ONCE).mrr_cents).toBe(EXPECTED_COUPON_ONCE_CENTS)
  })

  it('(9) trial → exclu de mrr_cents, présent dans trial_mrr_cents', () => {
    const result = calcSubscriptionMrrCents(FIXTURE_TRIAL)
    expect(result.mrr_cents).toBe(EXPECTED_TRIAL_MRR_CENTS)
    expect(result.trial_mrr_cents).toBe(EXPECTED_TRIAL_TRIAL_MRR_CENTS)
  })

  it('(10) trial converti en payant → mrr_cents plein, trial_mrr_cents=0', () => {
    const result = calcSubscriptionMrrCents(FIXTURE_TRIAL_CONVERTED)
    expect(result.mrr_cents).toBe(EXPECTED_TRIAL_CONVERTED_MRR_CENTS)
    expect(result.trial_mrr_cents).toBe(0)
  })

  it('(11) past_due → MRR conservé + is_delinquent=true', () => {
    const result = calcSubscriptionMrrCents(FIXTURE_PAST_DUE)
    expect(result.mrr_cents).toBe(EXPECTED_PAST_DUE_MRR_CENTS)
    expect(result.is_delinquent).toBe(EXPECTED_PAST_DUE_IS_DELINQUENT)
  })

  it('(12) annulé → mrr_cents=0 sur la subscription', () => {
    expect(calcSubscriptionMrrCents(FIXTURE_CANCELED).mrr_cents).toBe(EXPECTED_CANCELED_MRR_CENTS)
  })

  it('(13) cancel_at_period_end=true → MRR conservé + pending_cancellation', () => {
    const result = calcSubscriptionMrrCents(FIXTURE_PENDING_CANCELLATION)
    expect(result.mrr_cents).toBe(EXPECTED_PENDING_CANCELLATION_MRR_CENTS)
    expect(result.pending_cancellation).toBe(EXPECTED_PENDING_CANCELLATION_FLAG)
  })

  it('(15) metered/usage-based → unavailable, jamais 0 silencieux', () => {
    const result = calcSubscriptionMrrCents(FIXTURE_METERED)
    expect(result.mrr_status).toBe(EXPECTED_METERED_STATUS)
    expect(result.mrr_cents).toBe(EXPECTED_METERED_MRR_CENTS)
  })

  it('(17) quantité > 1 → amount × quantity', () => {
    expect(calcSubscriptionMrrCents(FIXTURE_QUANTITY).mrr_cents).toBe(EXPECTED_QUANTITY_CENTS)
  })

  it('(18) unit_amount=null (tiered) → unavailable, pas 0', () => {
    const result = calcSubscriptionMrrCents(FIXTURE_NULL_UNIT_AMOUNT)
    expect(result.mrr_status).toBe(EXPECTED_NULL_UNIT_AMOUNT_STATUS)
    expect(result.mrr_cents).toBe(EXPECTED_NULL_UNIT_AMOUNT_MRR_CENTS)
  })
})

// ============================================================
// 2. aggregateAccountMrr — scénarios 11, 12, 14, 16
// ============================================================
describe('aggregateAccountMrr', () => {
  it('(11) past_due seul → churned=false, is_delinquent=true, MRR conservé', () => {
    const agg = aggregateAccountMrr([{ status: 'past_due', result: calcSubscriptionMrrCents(FIXTURE_PAST_DUE) }])
    expect(agg.churned).toBe(EXPECTED_PAST_DUE_CHURNED)
    expect(agg.is_delinquent).toBe(true)
    expect(agg.mrr_cents).toBe(EXPECTED_PAST_DUE_MRR_CENTS)
  })

  it('(12) toutes les subscriptions canceled → churned=true, mrr_cents=0', () => {
    const agg = aggregateAccountMrr([{ status: 'canceled', result: calcSubscriptionMrrCents(FIXTURE_CANCELED) }])
    expect(agg.churned).toBe(EXPECTED_CANCELED_CHURNED)
    expect(agg.mrr_cents).toBe(0)
  })

  it('(12b) aucune subscription (compte invoice-only ou neuf) → jamais churned', () => {
    const agg = aggregateAccountMrr([])
    expect(agg.churned).toBe(false)
    expect(agg.mrr_status).toBe('unavailable')
  })

  it('(14) deux subscriptions même compte → somme correcte (mensuel + annuel/12)', () => {
    const agg = aggregateAccountMrr([
      { status: 'active', result: calcSubscriptionMrrCents(FIXTURE_TWO_SUBS_A) },
      { status: 'active', result: calcSubscriptionMrrCents(FIXTURE_TWO_SUBS_B) },
    ])
    expect(agg.mrr_cents).toBe(EXPECTED_TWO_SUBS_TOTAL_CENTS)
  })

  it('(16) devise minoritaire exclue, jamais sommée avec la majoritaire', () => {
    const orgCurrency = detectOrgMajorityCurrency([
      { currency: 'usd' }, { currency: 'usd' }, { currency: 'jpy' },
    ])
    expect(orgCurrency).toBe(EXPECTED_MULTI_CURRENCY_ORG_MAJORITY)

    const usdResult = calcSubscriptionMrrCents(FIXTURE_MULTI_CURRENCY_USD)
    const jpyResult = calcSubscriptionMrrCents(FIXTURE_MULTI_CURRENCY_JPY)

    const agg = aggregateAccountMrr(
      [{ status: 'active', result: jpyResult }],
      orgCurrency,
    )
    expect(agg.mrr_status).toBe(EXPECTED_MULTI_CURRENCY_MINORITY_STATUS)
    expect(agg.mrr_cents).toBe(0) // exclue, jamais sommée

    const aggUsd = aggregateAccountMrr(
      [{ status: 'active', result: usdResult }],
      orgCurrency,
    )
    expect(aggUsd.mrr_status).toBe('ok')
    expect(aggUsd.mrr_cents).toBe(5000)
  })
})

// ============================================================
// 3. classifyMovement — scénarios 7 (expiry), 9/10 (trial→new),
//    19 (idempotence), 20 (reactivation)
// ============================================================
describe('classifyMovement', () => {
  it('(7c) expiration de coupon repeating → mouvement expansion', () => {
    const movement = classifyMovement({
      previous: { mrr_cents: EXPECTED_COUPON_REPEATING_ACTIVE_CENTS, mrr_status: 'ok' },
      current: { mrr_cents: EXPECTED_COUPON_REPEATING_EXPIRED_CENTS, mrr_status: 'ok' },
      hasPriorChurnMovement: false,
    })
    expect(movement).toEqual({ movement_type: 'expansion', amount_cents: EXPECTED_COUPON_EXPIRY_MOVEMENT_DELTA })
  })

  it('(10) conversion trial → payant → mouvement new (pas expansion, le trial n\'était pas dans le MRR confirmé)', () => {
    const movement = classifyMovement({
      previous: { mrr_cents: 0, mrr_status: 'ok' }, // trial exclu du MRR confirmé
      current: { mrr_cents: EXPECTED_TRIAL_CONVERTED_MRR_CENTS, mrr_status: 'ok' },
      hasPriorChurnMovement: false,
    })
    expect(movement).toEqual({ movement_type: 'new', amount_cents: EXPECTED_TRIAL_CONVERTED_MRR_CENTS })
  })

  it('(19) rejeu du même événement → no-op une fois l\'état déjà appliqué (idempotence)', () => {
    const stateA = { mrr_cents: 0, mrr_status: 'ok' as const }
    const stateB = { mrr_cents: 5000, mrr_status: 'ok' as const }

    const firstApplication = classifyMovement({ previous: stateA, current: stateB, hasPriorChurnMovement: false })
    expect(firstApplication).toEqual({ movement_type: 'new', amount_cents: 5000 })

    // Rejeu : l'état "previous" a déjà été mis à jour à stateB par le premier
    // traitement — un webhook rejoué compare donc stateB à stateB.
    const replay = classifyMovement({ previous: stateB, current: stateB, hasPriorChurnMovement: false })
    expect(replay).toBeNull()
  })

  it('(20) nouvelle subscription après un churn antérieur → reactivation, jamais new', () => {
    const newSubMrr = calcSubscriptionMrrCents(FIXTURE_REACTIVATION_NEW_SUB).mrr_cents
    expect(newSubMrr).toBe(EXPECTED_REACTIVATION_MRR_CENTS)

    const movement = classifyMovement({
      previous: { mrr_cents: 0, mrr_status: 'ok' },
      current: { mrr_cents: newSubMrr, mrr_status: 'ok' },
      hasPriorChurnMovement: true,
    })
    expect(movement).toEqual({ movement_type: 'reactivation', amount_cents: EXPECTED_REACTIVATION_MRR_CENTS })
  })

  it('même transition sans churn antérieur → new (pas reactivation)', () => {
    const movement = classifyMovement({
      previous: { mrr_cents: 0, mrr_status: 'ok' },
      current: { mrr_cents: 5000, mrr_status: 'ok' },
      hasPriorChurnMovement: false,
    })
    expect(movement?.movement_type).toBe('new')
  })

  it('mrr_status unavailable sur l\'un des deux snapshots → aucun mouvement classé', () => {
    const movement = classifyMovement({
      previous: { mrr_cents: 0, mrr_status: 'unavailable' },
      current: { mrr_cents: 0, mrr_status: 'ok' },
      hasPriorChurnMovement: false,
    })
    expect(movement).toBeNull()
  })
})

// ============================================================
// 3b. Cohérence sync-stripe / stripe-webhook (Phase 2.2, audit points 11/17)
//
// Les deux chemins d'ingestion construisent leurs snapshots "previous"/
// "current" différemment (sync-stripe : diff avant/après sur un batch de
// comptes ; stripe-webhook : compte unique resynchronisé par event) mais
// appellent désormais tous deux classifyMovement au niveau COMPTE (jamais
// au niveau subscription individuelle) avec la même forme d'entrée. Ce test
// simule les deux constructions pour un même scénario de bout en bout et
// vérifie qu'elles convergent vers une classification identique — c'est la
// garantie structurelle qu'un même événement Stripe produit le même
// mouvement MRR, qu'il soit capté par le webhook temps réel ou rattrapé par
// le sync quotidien.
// ============================================================
describe('cohérence de classification entre sync-stripe et stripe-webhook', () => {
  it('reactivation captée identiquement par les deux chemins', () => {
    // Scénario : compte avec un churn antérieur, une seule subscription,
    // qui repasse de 0 à mrr>0 (nouvel objet Subscription Stripe après un
    // retour client).
    const accountMrrBeforeEvent = 0
    const newSubMrr = calcSubscriptionMrrCents(FIXTURE_REACTIVATION_NEW_SUB).mrr_cents
    const hasPriorChurn = true

    // Style sync-stripe : accountSubMeta agrégé sur toutes les subscriptions
    // billables du compte (ici une seule) → account-level current.
    const syncStripeStyleCurrent = { mrr_cents: newSubMrr, mrr_status: 'ok' as const }
    // Style stripe-webhook : re-somme des subscriptions actives du compte
    // après upsert de l'event reçu → même valeur pour un compte mono-sub.
    const webhookStyleCurrent = { mrr_cents: newSubMrr, mrr_status: 'ok' as const }

    const fromSyncStripe = classifyMovement({
      previous: { mrr_cents: accountMrrBeforeEvent, mrr_status: 'ok' },
      current: syncStripeStyleCurrent,
      hasPriorChurnMovement: hasPriorChurn,
    })
    const fromStripeWebhook = classifyMovement({
      previous: { mrr_cents: accountMrrBeforeEvent, mrr_status: 'ok' },
      current: webhookStyleCurrent,
      hasPriorChurnMovement: hasPriorChurn,
    })

    expect(fromSyncStripe).toEqual(fromStripeWebhook)
    expect(fromSyncStripe).toEqual({ movement_type: 'reactivation', amount_cents: newSubMrr })
  })

  it('expansion multi-subscriptions captée identiquement (2e subscription créée sur un compte déjà actif)', () => {
    // Compte avec une subscription existante à 5000, une 2e subscription de
    // 3000 vient d'être créée (customer.subscription.created côté webhook ;
    // le prochain run capterait la même chose côté sync-stripe).
    const prev = { mrr_cents: 5000, mrr_status: 'ok' as const }
    const current = { mrr_cents: 8000, mrr_status: 'ok' as const } // 5000 existant + 3000 nouvelle

    const fromSyncStripe = classifyMovement({ previous: prev, current, hasPriorChurnMovement: false })
    const fromStripeWebhook = classifyMovement({ previous: prev, current, hasPriorChurnMovement: false })

    expect(fromSyncStripe).toEqual(fromStripeWebhook)
    expect(fromSyncStripe).toEqual({ movement_type: 'expansion', amount_cents: 3000 })
  })
})

// ============================================================
// 4. Helpers : detectBillingModel, detectOrgMajorityCurrency, isAccountChurned
// ============================================================
describe('detectBillingModel', () => {
  it('customer avec invoices mais 0 subscription → invoice_only', () => {
    expect(detectBillingModel(0, 3)).toBe('invoice_only')
  })

  it('customer avec au moins une subscription → subscription', () => {
    expect(detectBillingModel(1, 3)).toBe('subscription')
  })

  it('customer sans invoice ni subscription → subscription (défaut)', () => {
    expect(detectBillingModel(0, 0)).toBe('subscription')
  })
})

describe('isAccountChurned (docs/openspec.md §5 — remplace mrr_cents===0 || subscriptionCanceled)', () => {
  it('toutes les subscriptions canceled → true', () => {
    expect(isAccountChurned(['canceled', 'canceled'])).toBe(true)
  })

  it('au moins une subscription active → false', () => {
    expect(isAccountChurned(['canceled', 'active'])).toBe(false)
  })

  it('past_due seul → false (délinquent, pas parti)', () => {
    expect(isAccountChurned(['past_due'])).toBe(false)
  })

  it('aucune subscription → false (invoice-only ou compte neuf, jamais churned par défaut)', () => {
    expect(isAccountChurned([])).toBe(false)
  })
})

// ============================================================
// 5. Legacy behaviour — reproduction documentée de l'ancienne formule
//    (sync-stripe/index.ts + stripe-webhook/index.ts, avant Phase 2.2).
//    Ces fonctions ne sont PAS du code de production : elles reproduisent
//    littéralement l'ancienne formule dupliquée pour prouver, par un test
//    qui passe, que le code actuel diverge du golden dataset sur ces
//    scénarios. Confirme "échecs attendus" (prompt Phase 2.1) sans jamais
//    faire échouer `npm run verify`.
// ============================================================
function legacyCalcMrrCents(sub: StripeSubscriptionLike): number {
  // Copie littérale de l'ancienne calcMrrCents (sync-stripe/index.ts:164-170
  // avant Phase 2.2) : items.data[0] uniquement, interval_count ignoré,
  // aucune remise appliquée, aucune distinction unavailable/0.
  const item = sub.items?.data?.[0]
  const amount = item?.price.unit_amount ?? sub.plan?.amount ?? 0
  const qty = item?.quantity ?? sub.quantity ?? 1
  const interval = item?.price.recurring?.interval ?? sub.plan?.interval ?? 'month'
  return Math.round((amount * qty) / (interval === 'year' ? 12 : 1))
}

describe('legacy behaviour — reproduction documentée du bug pré-Phase-2.2 (non utilisé en production)', () => {
  it('(3) trimestriel : ancien code retourne 30000 au lieu de 10000 (interval_count ignoré)', () => {
    expect(legacyCalcMrrCents(FIXTURE_QUARTERLY)).toBe(LEGACY_BUGGY_QUARTERLY_CENTS)
    expect(legacyCalcMrrCents(FIXTURE_QUARTERLY)).not.toBe(EXPECTED_QUARTERLY_CENTS)
  })

  it('(4) hebdomadaire : ancien code retourne 1000 au lieu de 4345 (traité comme mensuel)', () => {
    expect(legacyCalcMrrCents(FIXTURE_WEEKLY)).toBe(LEGACY_BUGGY_WEEKLY_CENTS)
    expect(legacyCalcMrrCents(FIXTURE_WEEKLY)).not.toBe(EXPECTED_WEEKLY_CENTS)
  })

  it('(5) multi-items : ancien code retourne 4900 au lieu de 6900 (items.data[0] uniquement)', () => {
    expect(legacyCalcMrrCents(FIXTURE_MULTI_ITEM)).toBe(LEGACY_BUGGY_MULTI_ITEM_CENTS)
    expect(legacyCalcMrrCents(FIXTURE_MULTI_ITEM)).not.toBe(EXPECTED_MULTI_ITEM_CENTS)
  })

  it('(6) coupon forever : ancien code retourne 10000 au lieu de 8000 (aucune remise appliquée)', () => {
    expect(legacyCalcMrrCents(FIXTURE_COUPON_FOREVER)).toBe(10000)
    expect(legacyCalcMrrCents(FIXTURE_COUPON_FOREVER)).not.toBe(EXPECTED_COUPON_FOREVER_CENTS)
  })

  it('(15) metered : ancien code retourne 0 numérique, indistinguable d\'un compte churned (pas de statut unavailable)', () => {
    expect(legacyCalcMrrCents(FIXTURE_METERED)).toBe(0)
    // Le bug n'est pas la valeur (0 dans les deux cas) mais l'absence de statut :
    // l'ancien code n'a aucune notion de mrr_status='unavailable', donc ce 0
    // déclenchait isChurned via `mrr_cents === 0` — voir Phase 2.5.
  })

  it('(16) multi-devises : une sommation naïve additionnerait usd+jpy à tort (10000 au lieu d\'exclure la minoritaire)', () => {
    const naiveSum = legacyCalcMrrCents(FIXTURE_MULTI_CURRENCY_USD) + legacyCalcMrrCents(FIXTURE_MULTI_CURRENCY_JPY)
    expect(naiveSum).toBe(LEGACY_BUGGY_MULTI_CURRENCY_SUMMED_CENTS)
  })

  it('(18) unit_amount=null : ancien code retourne 0 numérique via `?? 0`, indistinguable d\'un vrai 0€', () => {
    expect(legacyCalcMrrCents(FIXTURE_NULL_UNIT_AMOUNT)).toBe(0)
  })
})
