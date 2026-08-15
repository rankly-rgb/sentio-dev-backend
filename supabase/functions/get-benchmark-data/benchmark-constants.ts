/**
 * Benchmarks externes SaaS B2B — seuils et sources.
 *
 * Les champs excellent/bon/correct/mediocre servent à la fois de
 * valeurs affichées sur la gauge bar ET de seuils pour le rating.
 *
 * Rating :
 *   NRR & MRR Growth : >= excellent → "excellent", >= bon → "bon", etc.
 *   Churn Rate (inversé) : <= excellent → "excellent", <= bon → "bon", etc.
 */

export const EXTERNAL_BENCHMARKS = {
  nrr: {
    excellent: 120,
    bon: 100,
    correct: 90,
    mediocre: 80,
    sources: ['OpenView 2024', 'Bessemer Cloud Index'],
  },
  churn_rate: {
    /** Inversé : plus bas = mieux. <= 1 = excellent, <= 3 = bon, <= 5 = correct, > 5 = médiocre */
    excellent: 1,
    bon: 3,
    correct: 5,
    mediocre: 8,
    sources: ['Recurly 2024', 'ProfitWell'],
  },
  mrr_growth: {
    excellent: 15,
    bon: 8,
    correct: 3,
    mediocre: 0,
    sources: ['SaaS Capital 2024'],
  },
} as const

export type MetricKey = keyof typeof EXTERNAL_BENCHMARKS
export type Rating = 'excellent' | 'bon' | 'correct' | 'médiocre'

/** Minimum d'organisations pour exposer les peer benchmarks (protection vie privée). */
export const MIN_PEER_ORG_COUNT = 3
