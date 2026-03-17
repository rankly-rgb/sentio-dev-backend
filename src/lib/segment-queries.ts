/**
 * Segment filters — source of truth aligned with backend scoring.ts
 * Used by: segments list, segment detail, export CSV
 */
import type { Account } from '@/lib/types/accounts'

export type SegmentKey =
  | 'champions'
  | 'en_expansion'
  | 'stables'
  | 'a_risque_leger'
  | 'en_danger_critique'
  | 'impayes'
  | 'en_churn'
  | 'nouveaux'

export interface SegmentMeta {
  key: SegmentKey
  label: string
  description: string
  color: string
  bgColor: string
  borderColor: string
}

export const SEGMENTS: SegmentMeta[] = [
  {
    key: 'champions',
    label: 'Champions',
    description: 'Comptes en excellente santé',
    color: 'text-emerald-700',
    bgColor: 'bg-emerald-50',
    borderColor: 'border-emerald-200',
  },
  {
    key: 'en_expansion',
    label: 'En expansion',
    description: 'Forte opportunité de croissance',
    color: 'text-blue-700',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
  },
  {
    key: 'stables',
    label: 'Stables',
    description: 'Comptes sains sans risque particulier',
    color: 'text-slate-700',
    bgColor: 'bg-slate-50',
    borderColor: 'border-slate-200',
  },
  {
    key: 'a_risque_leger',
    label: 'À risque léger',
    description: 'Signaux d\'alerte modérés',
    color: 'text-amber-700',
    bgColor: 'bg-amber-50',
    borderColor: 'border-amber-200',
  },
  {
    key: 'en_danger_critique',
    label: 'En danger critique',
    description: 'Risque de churn élevé',
    color: 'text-red-700',
    bgColor: 'bg-red-50',
    borderColor: 'border-red-200',
  },
  {
    key: 'impayes',
    label: 'Impayés',
    description: 'Problèmes de paiement détectés',
    color: 'text-rose-700',
    bgColor: 'bg-rose-50',
    borderColor: 'border-rose-200',
  },
  {
    key: 'en_churn',
    label: 'En churn',
    description: 'Comptes perdus (MRR = 0)',
    color: 'text-gray-700',
    bgColor: 'bg-gray-50',
    borderColor: 'border-gray-200',
  },
  {
    key: 'nouveaux',
    label: 'Nouveaux (< 90j)',
    description: 'Comptes créés récemment',
    color: 'text-indigo-700',
    bgColor: 'bg-indigo-50',
    borderColor: 'border-indigo-200',
  },
]

/** Helper: does the account have Stripe data? */
function hasStripe(a: Account): boolean {
  return a.stripe_customer_id != null
}

/**
 * In-memory segment filters — aligned with backend scoring.ts determineSegmentTypes()
 * HubSpot-only accounts (no stripe_customer_id) skip MRR-dependent checks.
 */
export const SEGMENT_FILTERS: Record<SegmentKey, (a: Account) => boolean> = {
  champions: (a) =>
    (a.health_score ?? 0) >= 80 && (a.churn_risk_score ?? 100) < 50,

  en_expansion: (a) =>
    (a.expansion_score ?? 0) >= 70 &&
    (a.health_score ?? 0) >= 60 &&
    (a.health_score ?? 0) < 80 &&
    (a.churn_risk_score ?? 100) < 50,

  stables: (a) => {
    const churn = a.churn_risk_score ?? 100
    const health = a.health_score ?? 0
    const expansion = a.expansion_score ?? 0
    const isStableScore = churn < 50 && health < 80 && !(expansion >= 70 && health >= 60)
    if (!hasStripe(a)) return isStableScore
    return (a.mrr_cents ?? 0) > 0 && isStableScore
  },

  a_risque_leger: (a) => {
    const churn = a.churn_risk_score ?? 0
    if (!hasStripe(a)) return churn >= 50 && churn < 70
    return churn >= 50 && churn < 70 && (a.mrr_cents ?? 0) > 0
  },

  en_danger_critique: (a) => {
    if (!hasStripe(a)) return (a.churn_risk_score ?? 0) >= 70
    return (a.churn_risk_score ?? 0) >= 70 && (a.mrr_cents ?? 0) > 0
  },

  impayes: (a) =>
    hasStripe(a) &&
    (a.churn_risk_score ?? 0) > 80 &&
    (a.health_score ?? 0) < 50 &&
    (a.mrr_cents ?? 0) > 0,

  en_churn: (a) => hasStripe(a) && (a.mrr_cents ?? 0) === 0,

  nouveaux: (a) => {
    if (!a.created_at) return false
    const diffMs = Date.now() - new Date(a.created_at).getTime()
    return diffMs < 90 * 24 * 60 * 60 * 1000
  },
}

export function getSegmentMeta(key: string): SegmentMeta | undefined {
  return SEGMENTS.find((s) => s.key === key)
}

export function formatMrr(cents: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

export function formatScore(score: number | null): string {
  if (score === null || score === undefined) return '—'
  return Math.round(score).toString()
}
