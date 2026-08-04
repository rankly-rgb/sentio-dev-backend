// ============================================================
// mrr-engine.test-fixtures.ts — Golden dataset MRR
//
// Jeu de fixtures Stripe synthétiques avec valeurs MRR/mouvement
// attendues calculées à la main selon docs/openspec.md. Sert de
// test de non-régression permanent au moteur (_shared/mrr-engine.ts).
// Écrit AVANT le câblage de sync-stripe/stripe-webhook sur le moteur
// (Phase 2.1 du prompt d'implémentation, cf. IMPLEMENTATION_LOG.md).
//
// Chaque scénario documente : la shape Stripe (clés minimales), le
// résultat attendu, et l'arithmétique qui y mène.
// ============================================================
import type { StripeSubscriptionLike } from './mrr-engine'

// ── (1) Mensuel simple ──────────────────────────────────────
// unit_amount=4900 * qty=1 / T(month, count=1)=1 → 4900
export const FIXTURE_MONTHLY_SIMPLE: StripeSubscriptionLike = {
  id: 'sub_monthly_simple',
  customer: 'cus_a',
  status: 'active',
  created: 1000,
  items: {
    data: [{ price: { unit_amount: 4900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }],
  },
  current_period_start: 1000,
  current_period_end: 2000,
}
export const EXPECTED_MONTHLY_SIMPLE_CENTS = 4900

// ── (2) Annuel /12 ───────────────────────────────────────────
// unit_amount=120000 * qty=1 / T(year, count=1)=12 → 10000
export const FIXTURE_ANNUAL: StripeSubscriptionLike = {
  id: 'sub_annual',
  customer: 'cus_b',
  status: 'active',
  created: 1000,
  items: {
    data: [{ price: { unit_amount: 120000, currency: 'usd', recurring: { interval: 'year', interval_count: 1 } }, quantity: 1 }],
  },
  current_period_start: 1000,
  current_period_end: 2000,
}
export const EXPECTED_ANNUAL_CENTS = 10000

// ── (3) Trimestriel (interval_count=3) ──────────────────────
// unit_amount=30000 * qty=1 / T(month, count=3)=3 → 10000
// L'ancienne formule (sync-stripe/stripe-webhook avant refactor) ignorait
// interval_count et divisait par 1 → retournait 30000 (×3 surestimé).
export const FIXTURE_QUARTERLY: StripeSubscriptionLike = {
  id: 'sub_quarterly',
  customer: 'cus_c',
  status: 'active',
  created: 1000,
  items: {
    data: [{ price: { unit_amount: 30000, currency: 'usd', recurring: { interval: 'month', interval_count: 3 } }, quantity: 1 }],
  },
  current_period_start: 1000,
  current_period_end: 2000,
}
export const EXPECTED_QUARTERLY_CENTS = 10000
export const LEGACY_BUGGY_QUARTERLY_CENTS = 30000

// ── (4) Hebdomadaire ─────────────────────────────────────────
// unit_amount=1000 * qty=1 * 4.345 / count=1 → 4345 (T=1/4.345 mois)
// L'ancienne formule traitait tout intervalle ≠ 'year' comme mensuel → 1000.
export const FIXTURE_WEEKLY: StripeSubscriptionLike = {
  id: 'sub_weekly',
  customer: 'cus_d',
  status: 'active',
  created: 1000,
  items: {
    data: [{ price: { unit_amount: 1000, currency: 'usd', recurring: { interval: 'week', interval_count: 1 } }, quantity: 1 }],
  },
  current_period_start: 1000,
  current_period_end: 2000,
}
export const EXPECTED_WEEKLY_CENTS = 4345
export const LEGACY_BUGGY_WEEKLY_CENTS = 1000

// ── (5) Multi-items (base + sièges) ─────────────────────────
// item1: 4900*1/1=4900 ; item2: 1000*2/1=2000 → total 6900
// L'ancienne formule ne lisait que items.data[0] → 4900 (perdait item2).
export const FIXTURE_MULTI_ITEM: StripeSubscriptionLike = {
  id: 'sub_multi_item',
  customer: 'cus_e',
  status: 'active',
  created: 1000,
  items: {
    data: [
      { price: { unit_amount: 4900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 },
      { price: { unit_amount: 1000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 2 },
    ],
  },
  current_period_start: 1000,
  current_period_end: 2000,
}
export const EXPECTED_MULTI_ITEM_CENTS = 6900
export const LEGACY_BUGGY_MULTI_ITEM_CENTS = 4900

// ── (6) Coupon forever 20% ───────────────────────────────────
// raw=10000, ×(1-0.20) → 8000
export const FIXTURE_COUPON_FOREVER: StripeSubscriptionLike = {
  id: 'sub_coupon_forever',
  customer: 'cus_f',
  status: 'active',
  created: 1000,
  items: {
    data: [{ price: { unit_amount: 10000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }],
  },
  discount: { coupon: { percent_off: 20, duration: 'forever' } },
  current_period_start: 1000,
  current_period_end: 2000,
}
export const EXPECTED_COUPON_FOREVER_CENTS = 8000

// ── (7) Coupon repeating actif puis expiré ──────────────────
// t0: raw=10000, coupon repeating 20% actif → 8000
// t1: même subscription, coupon disparu de `discounts` (Stripe l'a retiré
//     à expiration) → 10000. Le mouvement classifié entre t0 et t1 doit
//     être `expansion` de +2000 (voir mrr-engine.test.ts).
export const FIXTURE_COUPON_REPEATING_ACTIVE: StripeSubscriptionLike = {
  id: 'sub_coupon_repeating',
  customer: 'cus_g',
  status: 'active',
  created: 1000,
  items: {
    data: [{ price: { unit_amount: 10000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }],
  },
  discounts: [{ coupon: { percent_off: 20, duration: 'repeating', duration_in_months: 3 } }],
  current_period_start: 1000,
  current_period_end: 2000,
}
export const FIXTURE_COUPON_REPEATING_EXPIRED: StripeSubscriptionLike = {
  ...FIXTURE_COUPON_REPEATING_ACTIVE,
  discounts: [],
}
export const EXPECTED_COUPON_REPEATING_ACTIVE_CENTS = 8000
export const EXPECTED_COUPON_REPEATING_EXPIRED_CENTS = 10000
export const EXPECTED_COUPON_EXPIRY_MOVEMENT_DELTA = 2000

// ── (8) Coupon once (aucun effet MRR) ───────────────────────
export const FIXTURE_COUPON_ONCE: StripeSubscriptionLike = {
  id: 'sub_coupon_once',
  customer: 'cus_h',
  status: 'active',
  created: 1000,
  items: {
    data: [{ price: { unit_amount: 10000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }],
  },
  discounts: [{ coupon: { percent_off: 50, duration: 'once' } }],
  current_period_start: 1000,
  current_period_end: 2000,
}
export const EXPECTED_COUPON_ONCE_CENTS = 10000

// ── (9) Trial (exclu du MRR confirmé) ───────────────────────
export const FIXTURE_TRIAL: StripeSubscriptionLike = {
  id: 'sub_trial',
  customer: 'cus_i',
  status: 'trialing',
  created: 1000,
  items: {
    data: [{ price: { unit_amount: 4900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }],
  },
  trial_end: 2000,
  current_period_start: 1000,
  current_period_end: 2000,
}
export const EXPECTED_TRIAL_MRR_CENTS = 0
export const EXPECTED_TRIAL_TRIAL_MRR_CENTS = 4900

// ── (10) Trial → payant ─────────────────────────────────────
export const FIXTURE_TRIAL_CONVERTED: StripeSubscriptionLike = {
  ...FIXTURE_TRIAL,
  id: 'sub_trial', // même stripe_sub_id : Stripe transitionne l'objet, pas un nouveau
  status: 'active',
}
export const EXPECTED_TRIAL_CONVERTED_MRR_CENTS = 4900

// ── (11) past_due (MRR conservé, is_delinquent, pas churned) ─
export const FIXTURE_PAST_DUE: StripeSubscriptionLike = {
  id: 'sub_past_due',
  customer: 'cus_j',
  status: 'past_due',
  created: 1000,
  items: {
    data: [{ price: { unit_amount: 5000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }],
  },
  current_period_start: 1000,
  current_period_end: 2000,
}
export const EXPECTED_PAST_DUE_MRR_CENTS = 5000
export const EXPECTED_PAST_DUE_IS_DELINQUENT = true
export const EXPECTED_PAST_DUE_CHURNED = false

// ── (12) Annulé (churned) ────────────────────────────────────
export const FIXTURE_CANCELED: StripeSubscriptionLike = {
  id: 'sub_canceled',
  customer: 'cus_k',
  status: 'canceled',
  created: 1000,
  items: {
    data: [{ price: { unit_amount: 5000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }],
  },
  canceled_at: 1500,
  current_period_start: 1000,
  current_period_end: 2000,
}
export const EXPECTED_CANCELED_MRR_CENTS = 0
export const EXPECTED_CANCELED_CHURNED = true

// ── (13) cancel_at_period_end=true (MRR conservé, pending_cancellation) ─
export const FIXTURE_PENDING_CANCELLATION: StripeSubscriptionLike = {
  id: 'sub_pending_cancel',
  customer: 'cus_l',
  status: 'active',
  created: 1000,
  cancel_at_period_end: true,
  cancel_at: 2000,
  items: {
    data: [{ price: { unit_amount: 5000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }],
  },
  current_period_start: 1000,
  current_period_end: 2000,
}
export const EXPECTED_PENDING_CANCELLATION_MRR_CENTS = 5000
export const EXPECTED_PENDING_CANCELLATION_FLAG = true

// ── (14) Deux subscriptions même customer ───────────────────
// subA (mensuel $50) + subB (annuel $240/an → 2000/mois) → 7000
export const FIXTURE_TWO_SUBS_A: StripeSubscriptionLike = {
  id: 'sub_two_a',
  customer: 'cus_m',
  status: 'active',
  created: 1000,
  items: {
    data: [{ price: { unit_amount: 5000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }],
  },
  current_period_start: 1000,
  current_period_end: 2000,
}
export const FIXTURE_TWO_SUBS_B: StripeSubscriptionLike = {
  id: 'sub_two_b',
  customer: 'cus_m',
  status: 'active',
  created: 1000,
  items: {
    data: [{ price: { unit_amount: 24000, currency: 'usd', recurring: { interval: 'year', interval_count: 1 } }, quantity: 1 }],
  },
  current_period_start: 1000,
  current_period_end: 2000,
}
export const EXPECTED_TWO_SUBS_TOTAL_CENTS = 7000

// ── (15) Metered/usage-based (unavailable) ──────────────────
export const FIXTURE_METERED: StripeSubscriptionLike = {
  id: 'sub_metered',
  customer: 'cus_n',
  status: 'active',
  created: 1000,
  items: {
    data: [
      {
        price: { unit_amount: null, currency: 'usd', billing_scheme: 'per_unit', recurring: { interval: 'month', interval_count: 1, usage_type: 'metered' } },
      },
    ],
  },
  current_period_start: 1000,
  current_period_end: 2000,
}
export const EXPECTED_METERED_STATUS = 'unavailable'
export const EXPECTED_METERED_MRR_CENTS = 0
export const LEGACY_BUGGY_METERED_MRR_CENTS = 0 // même valeur, mais l'ancien code ne distinguait pas "unavailable" de "0" — voir test

// ── (16) Multi-devises (minoritaire exclue, jamais sommée) ──
// Org majoritairement 'usd'. Cette subscription est en 'jpy' → exclue.
export const FIXTURE_MULTI_CURRENCY_USD: StripeSubscriptionLike = {
  id: 'sub_currency_usd',
  customer: 'cus_o',
  status: 'active',
  created: 1000,
  items: {
    data: [{ price: { unit_amount: 5000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }],
  },
  current_period_start: 1000,
  current_period_end: 2000,
}
export const FIXTURE_MULTI_CURRENCY_JPY: StripeSubscriptionLike = {
  id: 'sub_currency_jpy',
  customer: 'cus_p',
  status: 'active',
  created: 1000,
  items: {
    data: [{ price: { unit_amount: 5000, currency: 'jpy', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }],
  },
  current_period_start: 1000,
  current_period_end: 2000,
}
export const EXPECTED_MULTI_CURRENCY_ORG_MAJORITY = 'usd'
export const EXPECTED_MULTI_CURRENCY_MINORITY_STATUS = 'unavailable'
export const LEGACY_BUGGY_MULTI_CURRENCY_SUMMED_CENTS = 10000 // 5000 usd + 5000 jpy sommés à tort

// ── (17) Quantité > 1 ─────────────────────────────────────────
// unit_amount=1000 * qty=5 / 1 → 5000
export const FIXTURE_QUANTITY: StripeSubscriptionLike = {
  id: 'sub_quantity',
  customer: 'cus_q',
  status: 'active',
  created: 1000,
  items: {
    data: [{ price: { unit_amount: 1000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 5 }],
  },
  current_period_start: 1000,
  current_period_end: 2000,
}
export const EXPECTED_QUANTITY_CENTS = 5000

// ── (18) unit_amount=null (tiered, non-metered) → unavailable, pas 0 ──
export const FIXTURE_NULL_UNIT_AMOUNT: StripeSubscriptionLike = {
  id: 'sub_null_amount',
  customer: 'cus_r',
  status: 'active',
  created: 1000,
  items: {
    data: [{ price: { unit_amount: null, currency: 'usd', billing_scheme: 'tiered', recurring: { interval: 'month', interval_count: 1 } } }],
  },
  current_period_start: 1000,
  current_period_end: 2000,
}
export const EXPECTED_NULL_UNIT_AMOUNT_STATUS = 'unavailable'
export const EXPECTED_NULL_UNIT_AMOUNT_MRR_CENTS = 0
export const LEGACY_BUGGY_NULL_UNIT_AMOUNT_MRR_CENTS = 0 // même 0 numérique, mais lu comme "aucun MRR" au lieu de "non chiffrable" — voir test

// ── (19) Rejeu du même événement (idempotence) — voir mrr-engine.test.ts ──
// Pas de fixture Stripe dédiée : test au niveau classifyMovement directement.

// ── (20) Churn puis nouvelle subscription (reactivation, pas new) ──
// Compte avec un mouvement `churn` antérieur, nouvelle subscription
// mrr=0→5000 → doit être classée `reactivation`, jamais `new`.
export const FIXTURE_REACTIVATION_NEW_SUB: StripeSubscriptionLike = {
  id: 'sub_reactivation',
  customer: 'cus_s',
  status: 'active',
  created: 5000,
  items: {
    data: [{ price: { unit_amount: 5000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }],
  },
  current_period_start: 5000,
  current_period_end: 6000,
}
export const EXPECTED_REACTIVATION_MRR_CENTS = 5000
