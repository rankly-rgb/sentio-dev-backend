// ============================================================
// mrr-engine.ts — Moteur MRR pur, conforme à docs/openspec.md
//
// AUCUNE dépendance Deno/jsr — fonctions pures, types seulement.
// Importable tel quel depuis Vitest (Node) ET depuis les Edge
// Functions Deno (import relatif .ts natif, pas de transpilation
// nécessaire). Voir docs/openspec.md §13.
//
// Seule implémentation autorisée du calcul MRR — sync-stripe et
// stripe-webhook doivent tous deux consommer ce module (pas de
// duplication locale, cf. AUDIT_LOGIQUE_METIER_STRIPE.md point 1).
// ============================================================

// ── Constantes de normalisation des intervalles (docs/openspec.md §3) ──
const WEEKS_PER_MONTH = 4.345
const DAYS_PER_MONTH = 30.437

// ── Types Stripe (formes minimales, indépendantes du SDK) ──────
export interface StripeCouponLike {
  percent_off?: number | null
  amount_off?: number | null
  duration: 'forever' | 'repeating' | 'once'
  duration_in_months?: number | null
}

export interface StripeDiscountLike {
  coupon: StripeCouponLike
}

export interface StripePriceLike {
  id?: string
  unit_amount: number | null
  currency?: string | null
  product?: string
  recurring?: {
    interval: string
    interval_count?: number
    usage_type?: string
  }
  billing_scheme?: string
}

export interface StripeSubscriptionItemLike {
  price: StripePriceLike
  quantity?: number
}

export interface StripeSubscriptionLike {
  id: string
  customer: string
  status: string
  quantity?: number
  created: number
  plan?: { amount: number; interval: string; id?: string; product?: string; currency?: string }
  items?: { data: StripeSubscriptionItemLike[] }
  // Stripe expose soit le champ historique singulier `discount`, soit le
  // tableau `discounts` (API récente). On normalise les deux en interne.
  discount?: StripeDiscountLike | null
  discounts?: Array<StripeDiscountLike | string> | null
  trial_end?: number | null
  cancel_at?: number | null
  cancel_at_period_end?: boolean
  canceled_at?: number | null
  // Non lus par calcSubscriptionMrrCents (les dates de contrat restent gérées
  // côté appelant) — optionnels pour ne pas contraindre la forme exacte des
  // types Stripe locaux de sync-stripe/stripe-webhook.
  current_period_start?: number | null
  current_period_end?: number | null
}

// ── Types de sortie ──────────────────────────────────────────
export type MrrStatus = 'ok' | 'unavailable'
export type BillingModel = 'subscription' | 'invoice_only'
export type MovementType = 'new' | 'expansion' | 'contraction' | 'churn' | 'reactivation' | 'correction'

// Statuts Stripe considérés "délinquents" (compte à risque, jamais churned).
const DELINQUENT_STATUSES = new Set(['past_due', 'unpaid'])
// Statuts qui contribuent au MRR confirmé (hors trial).
const BILLABLE_STATUSES = new Set(['active', 'past_due', 'unpaid'])

export interface SubscriptionMrrResult {
  mrr_cents: number
  trial_mrr_cents: number
  mrr_status: MrrStatus
  currency: string | null
  is_delinquent: boolean
  pending_cancellation: boolean
  interval_raw: string
  interval_count: number
}

/**
 * Durée d'une période de facturation, exprimée en mois (T).
 * mrr = montant_par_période / T — voir docs/openspec.md §3.
 */
function periodLengthInMonths(interval: string, intervalCount: number): number {
  switch (interval) {
    case 'year':
      return 12 * intervalCount
    case 'week':
      return intervalCount / WEEKS_PER_MONTH
    case 'day':
      return intervalCount / DAYS_PER_MONTH
    case 'month':
    default:
      return intervalCount
  }
}

function isItemUnpriceable(item: StripeSubscriptionItemLike): boolean {
  return item.price.unit_amount === null || item.price.unit_amount === undefined || item.price.recurring?.usage_type === 'metered'
}

function normalizeDiscounts(sub: StripeSubscriptionLike): StripeDiscountLike[] {
  const out: StripeDiscountLike[] = []
  if (sub.discount) out.push(sub.discount)
  if (sub.discounts) {
    for (const d of sub.discounts) {
      if (typeof d === 'object' && d !== null) out.push(d)
    }
  }
  return out
}

/**
 * Fraction du montant catalogue restant après application des remises
 * actives (coupons "forever"/"repeating" présents sur la subscription au
 * moment de la lecture — un coupon "repeating" expiré n'apparaît déjà plus
 * dans `discounts` côté Stripe, donc aucune logique de décompte de durée
 * n'est nécessaire ici : sa disparition fait naturellement remonter le MRR
 * au prochain calcul, classée `expansion` par classifyMovement). Un coupon
 * "once" ne s'applique qu'à une seule facture — jamais au MRR récurrent,
 * ignoré (docs/openspec.md §2).
 */
function applyDiscounts(rawMonthlyCents: number, discounts: StripeDiscountLike[]): number {
  let amount = rawMonthlyCents
  for (const { coupon } of discounts) {
    if (coupon.duration === 'once') continue
    if (typeof coupon.percent_off === 'number') {
      amount = amount * (1 - coupon.percent_off / 100)
    } else if (typeof coupon.amount_off === 'number') {
      amount = amount - coupon.amount_off
    }
  }
  return Math.max(0, Math.round(amount))
}

/**
 * Calcule le MRR d'une subscription Stripe unique, conforme à
 * docs/openspec.md (§2 source du montant, §3 intervalles, §4 trials,
 * §5 délinquence/pending_cancellation, §8.1 metered/usage-based).
 *
 * "no data ≠ neutral data" : une subscription non-chiffrable (metered,
 * unit_amount null) retourne mrr_status='unavailable' et mrr_cents=0 —
 * jamais un 0 qui se lirait comme "gratuit"/"sans MRR".
 */
export function calcSubscriptionMrrCents(sub: StripeSubscriptionLike): SubscriptionMrrResult {
  const items = sub.items?.data ?? []
  const primaryItem = items[0]
  const interval = primaryItem?.price.recurring?.interval ?? sub.plan?.interval ?? 'month'
  const intervalCount = primaryItem?.price.recurring?.interval_count ?? 1
  const currency = primaryItem?.price.currency ?? sub.plan?.currency ?? null

  const isDelinquent = DELINQUENT_STATUSES.has(sub.status)
  const pendingCancellation = sub.cancel_at_period_end === true
  const isTrial = sub.status === 'trialing'
  const isBillable = BILLABLE_STATUSES.has(sub.status) || isTrial

  // Aucun item chiffrable — pas de fallback vers `sub.plan` métered non plus.
  if (items.length === 0) {
    if (sub.plan && typeof sub.plan.amount === 'number') {
      const T = periodLengthInMonths(sub.plan.interval, 1)
      const monthly = applyDiscounts(sub.plan.amount / T, normalizeDiscounts(sub))
      return {
        mrr_cents: isTrial || !isBillable ? 0 : monthly,
        trial_mrr_cents: isTrial ? monthly : 0,
        mrr_status: 'ok',
        currency,
        is_delinquent: isDelinquent,
        pending_cancellation: pendingCancellation,
        interval_raw: sub.plan.interval,
        interval_count: 1,
      }
    }
    return {
      mrr_cents: 0,
      trial_mrr_cents: 0,
      mrr_status: 'unavailable',
      currency,
      is_delinquent: isDelinquent,
      pending_cancellation: pendingCancellation,
      interval_raw: interval,
      interval_count: intervalCount,
    }
  }

  // "no data ≠ neutral data" : un seul item non-chiffrable rend toute la
  // subscription non-chiffrable — jamais une somme partielle qui se lirait
  // comme un total complet.
  if (items.some(isItemUnpriceable)) {
    return {
      mrr_cents: 0,
      trial_mrr_cents: 0,
      mrr_status: 'unavailable',
      currency,
      is_delinquent: isDelinquent,
      pending_cancellation: pendingCancellation,
      interval_raw: interval,
      interval_count: intervalCount,
    }
  }

  const rawMonthly = items.reduce((sum, item) => {
    const itemInterval = item.price.recurring?.interval ?? interval
    const itemIntervalCount = item.price.recurring?.interval_count ?? 1
    const T = periodLengthInMonths(itemInterval, itemIntervalCount)
    const qty = item.quantity ?? sub.quantity ?? 1
    return sum + ((item.price.unit_amount as number) * qty) / T
  }, 0)

  const monthly = applyDiscounts(rawMonthly, normalizeDiscounts(sub))

  if (!isBillable) {
    // canceled / paused / incomplete : ni MRR confirmé, ni trial pipeline.
    return {
      mrr_cents: 0,
      trial_mrr_cents: 0,
      mrr_status: 'ok',
      currency,
      is_delinquent: isDelinquent,
      pending_cancellation: pendingCancellation,
      interval_raw: interval,
      interval_count: intervalCount,
    }
  }

  return {
    mrr_cents: isTrial ? 0 : monthly,
    trial_mrr_cents: isTrial ? monthly : 0,
    mrr_status: 'ok',
    currency,
    is_delinquent: isDelinquent,
    pending_cancellation: pendingCancellation,
    interval_raw: interval,
    interval_count: intervalCount,
  }
}

// ── Agrégation au niveau compte ─────────────────────────────────

export interface SubscriptionAggregateInput {
  status: string
  result: SubscriptionMrrResult
}

export interface AccountMrrAggregate {
  mrr_cents: number
  trial_mrr_cents: number
  mrr_status: MrrStatus
  is_delinquent: boolean
  pending_cancellation: boolean
  is_zero_dollar_active: boolean
  currency: string | null
  churned: boolean
}

/**
 * Agrège les subscriptions d'un compte. `orgMajorityCurrency` (vote
 * majoritaire calculé une fois par org via `detectOrgMajorityCurrency`,
 * docs/openspec.md §9) — toute subscription dont la devise diverge est
 * exclue des sommes et fait basculer `mrr_status` à 'unavailable' plutôt
 * que d'être additionnée silencieusement à une autre devise.
 */
export function aggregateAccountMrr(
  subs: SubscriptionAggregateInput[],
  orgMajorityCurrency: string | null = null,
): AccountMrrAggregate {
  if (subs.length === 0) {
    // Aucune subscription connue (invoice-only, ou compte pas encore
    // synchronisé) : "no data ≠ neutral data" — jamais churned par défaut
    // (docs/openspec.md §8.2), jamais un mrr_cents=0 lu comme "confirmé".
    return {
      mrr_cents: 0,
      trial_mrr_cents: 0,
      mrr_status: 'unavailable',
      is_delinquent: false,
      pending_cancellation: false,
      is_zero_dollar_active: false,
      currency: null,
      churned: false,
    }
  }

  const nonCanceled = subs.filter((s) => s.status !== 'canceled')

  const churned = subs.every((s) => s.status === 'canceled')

  if (churned) {
    return {
      mrr_cents: 0,
      trial_mrr_cents: 0,
      mrr_status: 'ok',
      is_delinquent: false,
      pending_cancellation: false,
      is_zero_dollar_active: false,
      currency: null,
      churned: true,
    }
  }

  let mrrCents = 0
  let trialMrrCents = 0
  let isDelinquent = false
  let pendingCancellation = false
  let hasUnavailable = false
  let currency: string | null = null

  for (const { result } of nonCanceled) {
    const currencyMismatch = orgMajorityCurrency !== null && result.currency !== null && result.currency !== orgMajorityCurrency

    if (result.mrr_status === 'unavailable' || currencyMismatch) {
      hasUnavailable = true
      isDelinquent = isDelinquent || result.is_delinquent
      pendingCancellation = pendingCancellation || result.pending_cancellation
      continue
    }

    mrrCents += result.mrr_cents
    trialMrrCents += result.trial_mrr_cents
    isDelinquent = isDelinquent || result.is_delinquent
    pendingCancellation = pendingCancellation || result.pending_cancellation
    if (currency === null) currency = result.currency
  }

  const isZeroDollarActive = nonCanceled.length > 0 && mrrCents === 0 && trialMrrCents === 0 && !hasUnavailable

  return {
    mrr_cents: mrrCents,
    trial_mrr_cents: trialMrrCents,
    mrr_status: hasUnavailable ? 'unavailable' : 'ok',
    is_delinquent: isDelinquent,
    pending_cancellation: pendingCancellation,
    is_zero_dollar_active: isZeroDollarActive,
    currency,
    churned: false,
  }
}

/**
 * `isChurned` conforme à docs/openspec.md §5 : uniquement quand TOUTES les
 * subscriptions du compte sont `canceled`. Remplace l'ancien prédicat
 * `mrr_cents === 0 || subscriptionCanceled` (D1) — voir note D-NEXT dans
 * CLAUDE.md. Un compte sans subscription du tout (invoice-only, ou pas
 * encore synchronisé) n'est PAS churned par construction (length === 0).
 */
export function isAccountChurned(subscriptionStatuses: string[]): boolean {
  return subscriptionStatuses.length > 0 && subscriptionStatuses.every((s) => s === 'canceled')
}

/**
 * Détecte le profil de facturation d'un compte (docs/openspec.md §8.2).
 * Un customer avec des invoices mais aucune subscription est facturé
 * "manuellement" (`send_invoice`) — jamais de MRR de repli dans cette
 * itération, juste une classification explicite plutôt qu'un mrr=0 silencieux.
 */
export function detectBillingModel(subscriptionCount: number, invoiceCount: number): BillingModel {
  return subscriptionCount === 0 && invoiceCount > 0 ? 'invoice_only' : 'subscription'
}

/**
 * Vote majoritaire de devise au niveau organisation (docs/openspec.md §9).
 * À calculer une fois par run de sync sur l'ensemble des subscriptions de
 * l'org, puis passer le résultat à `aggregateAccountMrr` par compte.
 */
export function detectOrgMajorityCurrency(subs: Array<{ currency: string | null }>): string | null {
  const counts = new Map<string, number>()
  for (const s of subs) {
    if (!s.currency) continue
    counts.set(s.currency, (counts.get(s.currency) ?? 0) + 1)
  }
  if (counts.size === 0) return null
  let best: string | null = null
  let bestCount = -1
  for (const [cur, n] of counts) {
    if (n > bestCount) {
      best = cur
      bestCount = n
    }
  }
  return best
}

// ── Classification des mouvements MRR ────────────────────────

export interface MrrSnapshot {
  mrr_cents: number
  mrr_status: MrrStatus
}

export interface MovementClassificationInput {
  /** null si le compte est nouveau (aucun snapshot précédent connu). */
  previous: MrrSnapshot | null
  current: MrrSnapshot
  /** Le compte porte-t-il au moins un mouvement `churn` dans son historique ? */
  hasPriorChurnMovement: boolean
}

export interface MovementResult {
  movement_type: Exclude<MovementType, 'correction'>
  amount_cents: number
}

/**
 * Classification unique des mouvements MRR — partagée par sync-stripe ET
 * stripe-webhook (docs/openspec.md §7, §11 audit). Fonction pure et
 * déterministe : mêmes entrées → même sortie, ce qui garantit que les deux
 * chemins d'ingestion produisent des classifications identiques pour le
 * même événement, et qu'un rejeu (mêmes previous/current) est un no-op
 * naturel une fois l'état déjà appliqué (voir test d'idempotence).
 *
 * Ne classe jamais de mouvement si l'un des deux snapshots est
 * `mrr_status='unavailable'` — on ne fabrique pas de mouvement à partir
 * d'un chiffre qu'on sait ne pas maîtriser.
 */
export function classifyMovement(input: MovementClassificationInput): MovementResult | null {
  const { previous, current, hasPriorChurnMovement } = input

  if (current.mrr_status === 'unavailable' || previous?.mrr_status === 'unavailable') {
    return null
  }

  const prevMrr = previous?.mrr_cents ?? 0
  const newMrr = current.mrr_cents

  if (prevMrr === 0 && newMrr > 0) {
    return { movement_type: hasPriorChurnMovement ? 'reactivation' : 'new', amount_cents: newMrr }
  }
  if (newMrr > prevMrr && prevMrr > 0) {
    return { movement_type: 'expansion', amount_cents: newMrr - prevMrr }
  }
  if (newMrr > 0 && newMrr < prevMrr) {
    return { movement_type: 'contraction', amount_cents: newMrr - prevMrr }
  }
  if (newMrr === 0 && prevMrr > 0) {
    return { movement_type: 'churn', amount_cents: -prevMrr }
  }
  return null
}

// ── NRR / churn rate (Phase 4 — endpoint portfolio-metrics) ──

export interface MrrMovementForNrr {
  movement_type: MovementType
  amount_cents: number
}

/**
 * NRR (Net Revenue Retention) sur l'historique complet des mouvements
 * fournis par l'appelant — `movements` doit déjà exclure movement_type
 * = 'correction' (docs/openspec.md §10, jamais compté dans le NRR).
 *
 * Convention de signe : `contraction` et `churn` sont stockés comme des
 * montants NÉGATIFS dans mrr_movements (voir classifyMovement ci-dessus —
 * `amount_cents: newMrr - prevMrr` pour contraction, `amount_cents:
 * -prevMrr` pour churn), donc on les ADDITIONNE pour obtenir le net, pas
 * question de les soustraire une seconde fois (ça inverserait leur effet).
 *
 * `null` si moins de 3 mois d'historique (`hasAtLeastThreeMonthsOfHistory`
 * à charge de l'appelant, ex. date du premier mouvement/compte de l'org)
 * ou si le MRR de départ calculé serait ≤ 0 (rien à mesurer).
 */
export function calcNrrPercentage(
  currentMrrCents: number,
  movements: MrrMovementForNrr[],
  hasAtLeastThreeMonthsOfHistory: boolean,
): number | null {
  if (!hasAtLeastThreeMonthsOfHistory) return null

  let newSum = 0
  let expansionSum = 0
  let contractionSum = 0
  let churnSum = 0
  let reactivationSum = 0

  for (const m of movements) {
    switch (m.movement_type) {
      case 'new': newSum += m.amount_cents; break
      case 'expansion': expansionSum += m.amount_cents; break
      case 'contraction': contractionSum += m.amount_cents; break // déjà négatif
      case 'churn': churnSum += m.amount_cents; break // déjà négatif
      case 'reactivation': reactivationSum += m.amount_cents; break
      // 'correction' : ignoré si présent malgré la consigne à l'appelant —
      // ne doit jamais influencer le NRR.
    }
  }

  const netMovements = newSum + expansionSum + reactivationSum + contractionSum + churnSum
  const mrrStartCents = currentMrrCents - netMovements
  if (mrrStartCents <= 0) return null

  const endingMrrExistingCents = currentMrrCents - newSum
  return Math.round((endingMrrExistingCents / mrrStartCents) * 1000) / 10
}

/**
 * % de MRR perdu sur les 30 derniers jours — `movementsLast30d` doit déjà
 * être filtré sur les 30 derniers jours et exclure 'correction'. Dénominateur
 * = MRR au début de la fenêtre de 30 jours (dérivé des mêmes mouvements que
 * le numérateur, cohérent avec calcNrrPercentage — pas une source séparée).
 * `null` si ce MRR de départ serait ≤ 0.
 */
export function calcChurnRate30d(
  currentMrrCents: number,
  movementsLast30d: MrrMovementForNrr[],
): number | null {
  let netMovements = 0
  let churnSum = 0
  for (const m of movementsLast30d) {
    if (m.movement_type === 'correction') continue
    netMovements += m.amount_cents
    if (m.movement_type === 'churn') churnSum += m.amount_cents // déjà négatif
  }

  const mrrStart30dCents = currentMrrCents - netMovements
  if (mrrStart30dCents <= 0) return null

  return Math.round((Math.abs(churnSum) / mrrStart30dCents) * 1000) / 10
}
