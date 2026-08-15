/**
 * Fonctions pures pour le calcul des métriques benchmark.
 * Testable avec Vitest — aucune dépendance Deno/jsr.
 */

import {
  EXTERNAL_BENCHMARKS,
  MIN_PEER_ORG_COUNT,
  type MetricKey,
  type Rating,
} from '../get-benchmark-data/benchmark-constants.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MrrMovementRow {
  movement_type: string
  amount_cents: number
}

export interface OrgMetrics {
  nrr: number | null
  churn_rate: number | null
  mrr_growth: number | null
}

export interface ExternalBenchmarkResult {
  excellent: number
  bon: number
  correct: number
  mediocre: number
  rating: Rating
  sources: readonly string[]
}

export interface PeerResult {
  available: boolean
  median: number | null
  org_count: number | null
  delta: number | null
}

export interface MetricResult {
  value: number | null
  external_benchmark: ExternalBenchmarkResult
  peer: PeerResult
}

export interface BenchmarkResponse {
  computed_at: string
  period_days: number
  metrics: {
    nrr: MetricResult
    churn_rate: MetricResult
    mrr_growth: MetricResult
  }
}

// ---------------------------------------------------------------------------
// Rating
// ---------------------------------------------------------------------------

/**
 * Détermine le rating d'une valeur par rapport aux seuils externes.
 *
 * NRR & MRR Growth : >= excellent → "excellent", >= bon → "bon", >= correct → "correct", sinon "médiocre"
 * Churn Rate (inversé) : <= excellent → "excellent", <= bon → "bon", <= correct → "correct", sinon "médiocre"
 */
export function computeRating(metric: MetricKey, value: number | null): Rating {
  if (value === null || value === undefined) return 'médiocre'

  const bench = EXTERNAL_BENCHMARKS[metric]

  if (metric === 'churn_rate') {
    // Inversé : plus bas est meilleur
    if (value <= bench.excellent) return 'excellent'
    if (value <= bench.bon) return 'bon'
    if (value <= bench.correct) return 'correct'
    return 'médiocre'
  }

  // NRR et MRR Growth : plus haut est meilleur
  if (value >= bench.excellent) return 'excellent'
  if (value >= bench.bon) return 'bon'
  if (value >= bench.correct) return 'correct'
  return 'médiocre'
}

// ---------------------------------------------------------------------------
// NRR (Net Revenue Retention) — 90 jours
// ---------------------------------------------------------------------------

/**
 * Calcule le NRR sur une période donnée.
 *
 * NRR = (MRR_début + expansion + reactivation - contraction - churn)
 *       / MRR_début × 100
 *
 * @param currentMrrCents MRR actuel total (SUM subscriptions actives)
 * @param movements mrr_movements des 90 derniers jours
 * @returns NRR arrondi à 1 décimale, ou null si MRR_début <= 0
 */
export function computeNrr(
  currentMrrCents: number,
  movements: MrrMovementRow[]
): number | null {
  let expansion = 0
  let reactivation = 0
  let contraction = 0
  let churn = 0
  let newBiz = 0

  for (const m of movements) {
    const amt = Math.abs(m.amount_cents)
    switch (m.movement_type) {
      case 'expansion':
        expansion += amt
        break
      case 'reactivation':
        reactivation += amt
        break
      case 'contraction':
        contraction += amt
        break
      case 'churn':
        churn += amt
        break
      case 'new':
        newBiz += amt
        break
    }
  }

  // MRR_début = MRR_actuel - net_movements
  // net = new + expansion + reactivation - contraction - churn
  const netMovements = newBiz + expansion + reactivation - contraction - churn
  const mrrStart = currentMrrCents - netMovements

  if (mrrStart <= 0) return null

  const nrr =
    ((mrrStart + expansion + reactivation - contraction - churn) / mrrStart) *
    100
  return Math.round(nrr * 10) / 10
}

// ---------------------------------------------------------------------------
// Churn Rate — 30 jours
// ---------------------------------------------------------------------------

/**
 * Calcule le taux de churn mensuel.
 *
 * churn_rate = (comptes_churned / comptes_début) × 100
 *
 * @param churnedCount nombre de comptes distincts ayant churné (30j)
 * @param startCount nombre de comptes existants il y a 30 jours
 * @returns churn_rate arrondi à 2 décimales, ou null si startCount <= 0
 */
export function computeChurnRate(
  churnedCount: number,
  startCount: number
): number | null {
  if (startCount <= 0) return null
  const rate = (churnedCount / startCount) * 100
  return Math.round(rate * 100) / 100
}

// ---------------------------------------------------------------------------
// MRR Growth — 30 jours
// ---------------------------------------------------------------------------

/**
 * Calcule la croissance MRR mensuelle.
 *
 * mrr_growth = (mrr_actuel - mrr_il_y_a_30j) / mrr_il_y_a_30j × 100
 *
 * @param currentMrrCents MRR actuel total
 * @param netMovements30d SUM des mrr_movements des 30 derniers jours (signé)
 * @returns mrr_growth arrondi à 1 décimale, ou null si MRR_30j_ago <= 0
 */
export function computeMrrGrowth(
  currentMrrCents: number,
  netMovements30d: number
): number | null {
  const mrr30dAgo = currentMrrCents - netMovements30d
  if (mrr30dAgo <= 0) return null
  const growth = ((currentMrrCents - mrr30dAgo) / mrr30dAgo) * 100
  return Math.round(growth * 10) / 10
}

// ---------------------------------------------------------------------------
// Peer comparison — médiane
// ---------------------------------------------------------------------------

/**
 * Calcule la médiane d'un tableau de nombres.
 * Ignore les valeurs null/undefined.
 */
export function computeMedian(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v !== null && v !== undefined)
  if (valid.length === 0) return null

  valid.sort((a, b) => a - b)
  const mid = Math.floor(valid.length / 2)
  if (valid.length % 2 === 0) {
    return Math.round(((valid[mid - 1] + valid[mid]) / 2) * 10) / 10
  }
  return Math.round(valid[mid] * 10) / 10
}

/**
 * Construit le résultat peer pour une métrique.
 */
export function buildPeerResult(
  orgValue: number | null,
  allOrgValues: (number | null)[],
  orgCount: number
): PeerResult {
  if (orgCount < MIN_PEER_ORG_COUNT) {
    return { available: false, median: null, org_count: null, delta: null }
  }
  const median = computeMedian(allOrgValues)
  const delta =
    orgValue !== null && median !== null
      ? Math.round((orgValue - median) * 10) / 10
      : null
  return { available: true, median, org_count: orgCount, delta }
}

// ---------------------------------------------------------------------------
// Assemblage
// ---------------------------------------------------------------------------

/**
 * Construit le résultat d'une métrique (valeur org + benchmark + peer).
 */
export function buildMetricResult(
  metric: MetricKey,
  value: number | null,
  peer: PeerResult
): MetricResult {
  const bench = EXTERNAL_BENCHMARKS[metric]
  return {
    value,
    external_benchmark: {
      excellent: bench.excellent,
      bon: bench.bon,
      correct: bench.correct,
      mediocre: bench.mediocre,
      rating: computeRating(metric, value),
      sources: bench.sources,
    },
    peer,
  }
}

/**
 * Calcule le montant net signé des movements.
 * new/expansion/reactivation = positif, contraction/churn = négatif.
 */
export function computeNetMovements(movements: MrrMovementRow[]): number {
  let net = 0
  for (const m of movements) {
    switch (m.movement_type) {
      case 'new':
      case 'expansion':
      case 'reactivation':
        net += m.amount_cents
        break
      case 'contraction':
      case 'churn':
        net -= m.amount_cents
        break
    }
  }
  return net
}
