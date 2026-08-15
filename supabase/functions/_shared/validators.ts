// ============================================================
// Validators — Shared validation helpers for Edge Functions
// No Deno/jsr imports (enables Vitest testing)
// ============================================================

export const VALID_SEGMENTS = [
  'champions', 'en_expansion', 'stables', 'a_risque_leger',
  'en_danger_critique', 'impayes', 'en_churn', 'nouveaux',
] as const

export type SegmentKey = typeof VALID_SEGMENTS[number]

export function isValidSegment(s: string): s is SegmentKey {
  return (VALID_SEGMENTS as readonly string[]).includes(s)
}

export const VALID_SORT_FIELDS = [
  'mrr_cents', 'health_score', 'churn_risk_score', 'expansion_score',
] as const

export type SortField = typeof VALID_SORT_FIELDS[number]

export function isValidSortField(s: string): s is SortField {
  return (VALID_SORT_FIELDS as readonly string[]).includes(s)
}

export const VALID_SORT_ORDERS = ['asc', 'desc'] as const

export type SortOrder = typeof VALID_SORT_ORDERS[number]

export function isValidSortOrder(s: string): s is SortOrder {
  return (VALID_SORT_ORDERS as readonly string[]).includes(s)
}
