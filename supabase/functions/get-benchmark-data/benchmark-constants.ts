/**
 * Benchmarks externes SaaS B2B — sources fiables, valeurs hardcodées.
 *
 * Sources :
 * - OpenView SaaS Benchmarks 2024
 * - Bessemer Venture Partners Cloud Index 2024
 * - Baremetrics SaaS Benchmarks 2024
 */

export const EXTERNAL_BENCHMARKS = {
  nrr: {
    /** Seuils : > 110 = excellent, 100-110 = bon, 90-100 = correct, < 90 = médiocre */
    thresholds: { excellent: 110, bon: 100, correct: 90 },
    values: { excellent: 120, bon: 110, correct: 100, mediocre: 90 },
    sources: [
      'OpenView SaaS Benchmarks 2024',
      'Bessemer Venture Partners Cloud Index 2024',
    ],
  },
  churn_rate: {
    /**
     * ATTENTION : pour churn_rate, un score PLUS BAS est MEILLEUR.
     * Seuils : < 0.5 = excellent, 0.5-1 = bon, 1-2 = correct, > 2 = médiocre
     */
    thresholds: { excellent: 0.5, bon: 1.0, correct: 2.0 },
    values: { excellent: 0.5, bon: 1.0, correct: 2.0, mediocre: 3.0 },
    sources: [
      'Baremetrics SaaS Benchmarks 2024',
      'OpenView SaaS Benchmarks 2024',
    ],
  },
  mrr_growth: {
    /** Seuils : > 15 = excellent, 10-15 = bon, 5-10 = correct, < 5 = médiocre */
    thresholds: { excellent: 15, bon: 10, correct: 5 },
    values: { excellent: 15, bon: 10, correct: 5, mediocre: 2 },
    sources: [
      'OpenView SaaS Benchmarks 2024',
      'Bessemer Venture Partners Cloud Index 2024',
    ],
  },
} as const

export type MetricKey = keyof typeof EXTERNAL_BENCHMARKS
export type Rating = 'excellent' | 'bon' | 'correct' | 'médiocre'

/** Minimum d'organisations pour exposer les peer benchmarks (protection vie privée). */
export const MIN_PEER_ORG_COUNT = 3
