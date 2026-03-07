// ============================================================
// Segment Export Helpers — Pure functions for segment CSV export
// No Deno/jsr imports (enables Vitest testing)
// ============================================================

export interface SegmentAccountRow {
  stripe_customer_id: string | null
  hubspot_company_id: string | null
  plan_tier: string | null
  billing_interval: string | null
  mrr_cents: number | null
  seat_count: number | null
  seat_limit: number | null
  contract_end_date: string | null
  health_score: number | null
  churn_risk_score: number | null
  expansion_score: number | null
  product_usage_score: number | null
  created_at: string | null
}

// ── Segment filters (must mirror frontend segment-queries.ts) ──

export const SEGMENT_FILTERS: Record<string, (a: SegmentAccountRow) => boolean> = {
  champions:          a => (a.health_score ?? 0) > 80 && (a.expansion_score ?? 0) > 70,
  en_expansion:       a => (a.expansion_score ?? 0) > 75,
  stables:            a => (a.health_score ?? 0) >= 60 && (a.health_score ?? 0) <= 80 && (a.churn_risk_score ?? 0) < 30,
  a_risque_leger:     a => ((a.health_score ?? 0) >= 40 && (a.health_score ?? 0) < 60) || ((a.churn_risk_score ?? 0) >= 30 && (a.churn_risk_score ?? 0) <= 50),
  en_danger_critique: a => (a.health_score ?? 0) < 40 || (a.churn_risk_score ?? 0) > 70,
  impayes:            a => (a.churn_risk_score ?? 0) > 80 && (a.health_score ?? 0) < 50,
  en_churn:           a => (a.churn_risk_score ?? 0) > 90,
  nouveaux:           a => {
    if (!a.created_at) return false
    const ninetyDaysAgo = new Date()
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)
    return new Date(a.created_at) > ninetyDaysAgo
  },
}

// ── CSV columns ──

export const SEGMENT_CSV_COLUMNS = [
  'stripe_customer_id',
  'hubspot_company_id',
  'plan_tier',
  'billing_interval',
  'mrr_eur',
  'seat_count',
  'seat_limit',
  'contract_end_date',
  'health_score',
  'churn_risk_score',
  'expansion_score',
  'product_usage_score',
] as const

// ── CSV helpers ──

function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return '"' + value.replace(/"/g, '""') + '"'
  }
  return value
}

function formatField(value: unknown): string {
  if (value === null || value === undefined) return ''
  return escapeCsvField(String(value))
}

export function convertMrrCentsToEur(mrrCents: number | null): string {
  if (mrrCents === null || mrrCents === undefined) return ''
  return (mrrCents / 100).toFixed(2)
}

/** UTF-8 BOM for Excel FR compatibility */
const BOM = '\uFEFF'

export function buildSegmentCsv(accounts: SegmentAccountRow[]): string {
  const lines: string[] = []

  // Column headers
  lines.push(SEGMENT_CSV_COLUMNS.join(','))

  // Data rows
  for (const acc of accounts) {
    const row = [
      formatField(acc.stripe_customer_id),
      formatField(acc.hubspot_company_id),
      formatField(acc.plan_tier),
      formatField(acc.billing_interval),
      convertMrrCentsToEur(acc.mrr_cents),
      formatField(acc.seat_count),
      formatField(acc.seat_limit),
      formatField(acc.contract_end_date),
      formatField(acc.health_score),
      formatField(acc.churn_risk_score),
      formatField(acc.expansion_score),
      formatField(acc.product_usage_score),
    ]
    lines.push(row.join(','))
  }

  return BOM + lines.join('\n') + '\n'
}
