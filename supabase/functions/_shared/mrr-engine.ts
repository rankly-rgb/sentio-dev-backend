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

// Mission réconciliation Stripe, point 2 (2026-08-20) : `mrr_status=
// 'unavailable'` recouvrait jusqu'ici 3 causes distinctes sans qu'aucune ne
// soit exposée — le frontend affichait un unique texte générique ("Not
// billable (known billing limitation)") quelle que soit la raison réelle.
// Un compte churné (`aggregateAccountMrr`, `churned: true`) N'EST PAS
// concerné : il retourne `mrr_status='ok'`/`mrr_cents=0`, déjà affiché
// correctement comme "$0.00" — pas de 4e valeur "legitimately zero after
// churn" nécessaire ici, cette hypothèse de l'audit ne tenait pas au niveau
// de ce champ.
export type MrrUnavailableReason =
  | 'no_subscription_data' // aucune subscription Stripe connue (invoice-only ou jamais synchronisé)
  | 'unsupported_pricing' // subscription existante mais non-chiffrable (metered, unit_amount null)
  | 'currency_mismatch' // subscription dans une devise minoritaire exclue du total de l'org

// Statuts Stripe considérés "délinquents" (compte à risque, jamais churned).
const DELINQUENT_STATUSES = new Set(['past_due', 'unpaid'])
// Statuts qui contribuent au MRR confirmé (hors trial).
const BILLABLE_STATUSES = new Set(['active', 'past_due', 'unpaid'])

export interface SubscriptionMrrResult {
  mrr_cents: number
  trial_mrr_cents: number
  mrr_status: MrrStatus
  mrr_unavailable_reason: MrrUnavailableReason | null
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
 * Montant catalogue restant après application des remises actives (coupons
 * "forever"/"repeating" présents sur la subscription au moment de la lecture
 * — un coupon "repeating" expiré n'apparaît déjà plus dans `discounts` côté
 * Stripe, donc aucune logique de décompte de durée n'est nécessaire ici : sa
 * disparition fait naturellement remonter le MRR au prochain calcul, classée
 * `expansion` par classifyMovement). Un coupon "once" ne s'applique qu'à une
 * seule facture — jamais au MRR récurrent, ignoré (docs/openspec.md §2).
 *
 * IMPORTANT — opère sur le montant PAR PÉRIODE DE FACTURATION (`amount_total`
 * de docs/openspec.md §3), PAS un montant déjà normalisé au mois. `coupon.
 * amount_off` chez Stripe est un montant fixe déduit du sous-total d'UNE
 * facture — un coupon "$10 off" sur un abonnement trimestriel retire $10 du
 * trimestre, pas $10 par mois. Appliquer amount_off après division par T
 * (l'ancien ordre, avant ce correctif) transformait silencieusement une
 * remise "$10/trimestre" en "$10/mois" (= $30/trimestre), pouvant même faire
 * chuter le MRR à $0 pour un forfait par ailleurs facturé normalement.
 * `percent_off` commute avec la division par T (l'ordre ne change rien pour
 * lui) — seul `amount_off` exigeait ce correctif, non couvert par le golden
 * dataset avant l'auto-vérification adversariale du 2026-08-04 (aucune
 * fixture n'utilisait `amount_off`).
 */
function applyDiscounts(rawPeriodCents: number, discounts: StripeDiscountLike[]): number {
  let amount = rawPeriodCents
  for (const { coupon } of discounts) {
    if (coupon.duration === 'once') continue
    if (typeof coupon.percent_off === 'number') {
      amount = amount * (1 - coupon.percent_off / 100)
    } else if (typeof coupon.amount_off === 'number') {
      amount = amount - coupon.amount_off
    }
  }
  return amount
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
      const discountedPeriodTotal = applyDiscounts(sub.plan.amount, normalizeDiscounts(sub))
      const monthly = Math.max(0, Math.round(discountedPeriodTotal / T))
      return {
        mrr_cents: isTrial || !isBillable ? 0 : monthly,
        trial_mrr_cents: isTrial ? monthly : 0,
        mrr_status: 'ok',
        mrr_unavailable_reason: null,
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
      mrr_unavailable_reason: 'unsupported_pricing',
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
      mrr_unavailable_reason: 'unsupported_pricing',
      currency,
      is_delinquent: isDelinquent,
      pending_cancellation: pendingCancellation,
      interval_raw: interval,
      interval_count: intervalCount,
    }
  }

  // Stripe exige que tous les items d'une même subscription partagent le
  // même intervalle de facturation (impossible de mélanger mensuel et
  // annuel sur une seule Subscription côté API Stripe) — un seul T pour
  // toute la subscription, dérivé de l'item principal (`interval`/
  // `intervalCount` ci-dessus), est donc suffisant et cohérent avec
  // `interval_raw`/`interval_count` retournés plus bas. On somme les
  // montants PAR PÉRIODE (sans diviser par T) pour que `applyDiscounts`
  // opère sur le vrai total facturé par cycle — nécessaire pour que
  // `amount_off` (montant fixe par facture chez Stripe) soit correct ; voir
  // le commentaire d'`applyDiscounts`.
  const T = periodLengthInMonths(interval, intervalCount)
  const rawPeriodTotal = items.reduce((sum, item) => {
    const qty = item.quantity ?? sub.quantity ?? 1
    return sum + (item.price.unit_amount as number) * qty
  }, 0)

  const discountedPeriodTotal = applyDiscounts(rawPeriodTotal, normalizeDiscounts(sub))
  const monthly = Math.max(0, Math.round(discountedPeriodTotal / T))

  if (!isBillable) {
    // canceled / paused / incomplete : ni MRR confirmé, ni trial pipeline.
    return {
      mrr_cents: 0,
      trial_mrr_cents: 0,
      mrr_status: 'ok',
      mrr_unavailable_reason: null,
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
    mrr_unavailable_reason: null,
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
  mrr_unavailable_reason: MrrUnavailableReason | null
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
      mrr_unavailable_reason: 'no_subscription_data',
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
      mrr_unavailable_reason: null,
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
  // Premier motif rencontré, dans l'ordre des subscriptions retournées par
  // Stripe — un compte avec plusieurs subscriptions non-chiffrables pour des
  // raisons différentes n'affiche qu'un seul motif (S1 n'exige pas un tableau
  // ici, juste de ne jamais fabriquer une raison qui n'a pas été observée).
  let unavailableReason: MrrUnavailableReason | null = null
  let currency: string | null = null

  for (const { result } of nonCanceled) {
    const currencyMismatch = orgMajorityCurrency !== null && result.currency !== null && result.currency !== orgMajorityCurrency

    if (result.mrr_status === 'unavailable' || currencyMismatch) {
      hasUnavailable = true
      if (unavailableReason === null) {
        unavailableReason = currencyMismatch && result.mrr_status !== 'unavailable' ? 'currency_mismatch' : result.mrr_unavailable_reason
      }
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
    mrr_unavailable_reason: hasUnavailable ? unavailableReason : null,
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

// ── MRR de repli invoice-only (mission réconciliation Stripe, point 4, 2026-08-20) ──
//
// Un compte `billing_model='invoice_only'` (facturé manuellement via
// send_invoice, aucun objet Subscription Stripe) recevait jusqu'ici
// systématiquement mrr_status='unavailable'/mrr_unavailable_reason=
// 'no_subscription_data' — même un compte payant depuis 17 mois
// consécutifs (cas réel App'Ines, PARKING_LOT.md 2026-08-17,
// cus_Rn6M1Tvnr0tOxS, $299/mois). Ce module dérive un MRR de repli à
// partir de l'historique de factures PAYÉES, uniquement quand deux
// factures payées récentes permettent d'observer une cadence réelle —
// jamais une cadence supposée (S1 : no data ≠ neutral data appliqué à la
// méthode d'estimation elle-même, pas seulement à sa présence/absence).
export interface InvoiceOnlyMrrInput {
  amountCents: number
  currency: string | null
  paidAt: string // ISO
}

export interface InvoiceOnlyMrrEstimate {
  mrr_cents: number
  currency: string | null
  estimated_from_invoice_count: number
  cadence_days: number
}

// Compte inactif au-delà de cette fenêtre depuis le dernier paiement connu
// → pas d'estimation (ne pas ressusciter une relation invoice-only
// réellement abandonnée). ~2x un cycle mensuel typique, marge de retard.
const INVOICE_ONLY_RECENCY_WINDOW_DAYS = 60

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Estime le MRR d'un compte invoice-only à partir de ses factures payées.
 * Retourne `null` — jamais un MRR fabriqué — si :
 *   - moins de 2 factures payées (aucune cadence observable, un seul point
 *     ne permet de déduire ni un intervalle mensuel, ni annuel, ni autre) ;
 *   - la facture payée la plus récente date de plus de
 *     `INVOICE_ONLY_RECENCY_WINDOW_DAYS` (compte probablement inactif) ;
 *   - aucun écart consécutif positif n'est observable (données
 *     incohérentes — doublons, horodatages invalides/identiques).
 *
 * La cadence est dérivée de la MÉDIANE des écarts entre factures payées
 * consécutives (pas seulement l'écart entre les deux plus récentes) —
 * corrigé 2026-08-20 suite à une vérification live sur le cas réel
 * App'Ines (cus_Rn6M1Tvnr0tOxS, PARKING_LOT.md) : un unique paiement en
 * retard (facture jamais payée) élargit l'écart entre les deux factures
 * payées les plus récentes à ~90 jours sur un compte facturé mensuellement
 * (~30 jours), sous-estimant le MRR réel d'un facteur ~3 avec la version
 * last-2-gap. La médiane sur l'ensemble de l'historique reste robuste à un
 * seul écart irrégulier tant que la majorité des paiements sont réguliers.
 * `mrr_cents` = montant de la facture la plus récente, normalisé au mois
 * selon cette cadence médiane.
 */
export function estimateInvoiceOnlyMrr(
  paidInvoices: InvoiceOnlyMrrInput[],
  now: number = Date.now(),
): InvoiceOnlyMrrEstimate | null {
  if (paidInvoices.length < 2) return null

  const sorted = [...paidInvoices].sort((a, b) => new Date(a.paidAt).getTime() - new Date(b.paidAt).getTime())
  const mostRecent = sorted[sorted.length - 1]

  const daysSinceLastPayment = (now - new Date(mostRecent.paidAt).getTime()) / (1000 * 60 * 60 * 24)
  if (daysSinceLastPayment > INVOICE_ONLY_RECENCY_WINDOW_DAYS) return null

  const gapDays: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const gap = (new Date(sorted[i].paidAt).getTime() - new Date(sorted[i - 1].paidAt).getTime()) / (1000 * 60 * 60 * 24)
    if (gap > 0) gapDays.push(gap)
  }
  if (gapDays.length === 0) return null

  const cadenceDays = median(gapDays)
  const cadenceMonths = cadenceDays / DAYS_PER_MONTH
  const mrrCents = Math.max(0, Math.round(mostRecent.amountCents / cadenceMonths))

  return {
    mrr_cents: mrrCents,
    currency: mostRecent.currency,
    estimated_from_invoice_count: sorted.length,
    cadence_days: Math.round(cadenceDays),
  }
}

export interface DelinquentSubscriptionInput {
  status: string
  contractStart: string | null
}

/**
 * Lot 5 (2026-08-13, #35) — délinquence par durée. Candidat de date pour
 * `accounts.delinquent_since` : la plus ancienne `current_period_start`
 * (accountSubMeta.contractStart, sync-stripe/index.ts) parmi les
 * subscriptions actuellement en statut délinquent (`past_due`/`unpaid`).
 *
 * DÉCISION AUTONOME : la priorité à 3 niveaux prévue (invoice.status_
 * transitions → invoice.due_date → current_period_start) n'est
 * qu'à moitié réalisable telle quelle. `is_delinquent` est produit par
 * `aggregateAccountMrr`, fonction pure sans accès aux invoices ; et
 * `sync-stripe` ne les a de toute façon pas encore fetchées à ce stade du
 * pipeline (`syncCustomers` → `syncSubscriptions` → `syncInvoices`). Seul
 * le 3e niveau (déjà en mémoire dans `accountSubMeta`) est
 * architecturalement disponible sans restructuration disproportionnée du
 * chemin de sync pour ce chantier. Simplification assumée, cohérente avec
 * S1 : jamais de date fabriquée — `null` si aucune subscription délinquente
 * n'a de `contractStart` connu.
 */
export function computeDelinquentSinceCandidate(subs: DelinquentSubscriptionInput[]): string | null {
  let earliest: string | null = null
  for (const sub of subs) {
    if (!DELINQUENT_STATUSES.has(sub.status) || !sub.contractStart) continue
    if (earliest === null || sub.contractStart < earliest) earliest = sub.contractStart
  }
  return earliest
}

/**
 * Résolution "sticky" de `accounts.delinquent_since`. Vit délibérément hors
 * d'`aggregateAccountMrr` : c'est une fonction pure sans accès DB, seul
 * l'appelant (sync-stripe/index.ts) connaît la valeur déjà persistée.
 *
 * - non-délinquent → non-délinquent : reste `null`.
 * - devient délinquent (`previousDelinquentSince === null`) : prend le
 *   candidat de ce run (peut être `null` si aucune date connue — jamais
 *   `now()`, S1).
 * - délinquence continue (`previousDelinquentSince` déjà connu) : la
 *   préserve, ne la remplace JAMAIS par le candidat du run courant — sinon
 *   un compte délinquent depuis 40 jours "rajeunirait" dès qu'une nouvelle
 *   subscription passe `past_due` sur le même compte.
 * - redevient non-délinquent : repasse à `null`.
 */
export function resolveDelinquentSince(
  isDelinquentNow: boolean,
  previousDelinquentSince: string | null,
  candidateSinceIso: string | null,
): string | null {
  if (!isDelinquentNow) return null
  if (previousDelinquentSince !== null) return previousDelinquentSince
  return candidateSinceIso
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
 *
 * Égalité stricte (ex. 1 subscription USD + 1 EUR) : départage
 * déterministe par ordre lexicographique du code devise, jamais par ordre
 * d'arrivée dans `subs` — sans ça, deux runs de `sync-stripe` sur la même
 * organisation pourraient élire une devise majoritaire différente selon
 * l'ordre de pagination retourné par Stripe/la requête DB (non garanti
 * stable d'un run à l'autre), faisant flapper `organizations.currency` et
 * le `mrr_status` des comptes en devise "minoritaire" sans qu'aucun client
 * n'ait rien changé. Trouvé lors de l'auto-vérification adversariale du
 * 2026-08-04 — non couvert par le golden dataset original (le seul test
 * d'égalité stricte alors présent utilisait une vraie majorité 2 contre 1).
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
    if (n > bestCount || (n === bestCount && best !== null && cur < best)) {
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
 *
 * `null` si moins de 3 mois d'historique (même garde bootstrap que
 * calcNrrPercentage, `hasAtLeastThreeMonthsOfHistory` à charge de
 * l'appelant) ou si le MRR de départ calculé serait ≤ 0. Avant ce correctif,
 * `mrr_movements` totalement vide (zéro ligne, jamais) produisait un
 * `0.0%` indiscernable d'un portefeuille réellement sans churn — le même
 * défaut "absence de données lue comme mesure" que le fallback `100` corrigé
 * sur le NRR (audit 2026-08-06, Priorité 1) : `netMovements` vaut alors 0,
 * `mrrStart30dCents` reste positif (= `currentMrrCents`), et `churnSum` reste
 * 0 faute de toute ligne à sommer — le calcul ne peut pas distinguer "aucun
 * mouvement de churn observé" de "aucun mouvement n'est jamais enregistré".
 */
export function calcChurnRate30d(
  currentMrrCents: number,
  movementsLast30d: MrrMovementForNrr[],
  hasAtLeastThreeMonthsOfHistory: boolean,
): number | null {
  if (!hasAtLeastThreeMonthsOfHistory) return null

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

export interface MrrGrowthMetrics {
  net_movements_cents: number
  starting_mrr_cents: number
  churn_rate_percentage: number | null
  mrr_growth_percentage: number | null
}

/**
 * Churn rate + croissance MRR sur une fenêtre de mouvements arbitraire
 * (12 mois glissants pour /dashboard-api/benchmarks — même garde bootstrap,
 * même convention de signe que calcNrrPercentage/calcChurnRate30d ci-dessus :
 * contraction/churn sont déjà négatifs, additionnés jamais soustraits).
 * Extrait hors dashboard-api/index.ts (issue #28 : une copie locale
 * "- contraction - churn" y gonflait netMovements/mrrGrowth et rendait
 * churnRate négatif) pour rester directement testable — index.ts a des
 * imports Deno-natifs non résolvables sous Vitest.
 */
export function calcMrrGrowthMetrics(
  currentMrrCents: number,
  movements: MrrMovementForNrr[],
  hasAtLeastThreeMonthsOfHistory: boolean,
): MrrGrowthMetrics {
  let netMovements = 0
  let churnSum = 0
  for (const m of movements) {
    if (m.movement_type === 'correction') continue
    netMovements += m.amount_cents
    if (m.movement_type === 'churn') churnSum += m.amount_cents // déjà négatif
  }

  const startingMrrCents = currentMrrCents - netMovements
  const hasValidWindow = hasAtLeastThreeMonthsOfHistory && startingMrrCents > 0

  return {
    net_movements_cents: netMovements,
    starting_mrr_cents: startingMrrCents,
    churn_rate_percentage: hasValidWindow
      ? Math.min(100, Math.round((Math.abs(churnSum) / startingMrrCents) * 1000) / 10)
      : null,
    mrr_growth_percentage: hasValidWindow
      ? Math.round((netMovements / startingMrrCents) * 1000) / 10
      : null,
  }
}
