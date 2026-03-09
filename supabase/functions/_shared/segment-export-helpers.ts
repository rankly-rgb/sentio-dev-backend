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

// ── Segment filters — aligned with scoring.ts determineSegmentTypes() ──
// Priority order (mutually exclusive except nouveaux):
//   1. en_churn (mrr=0) → 2. impayes (overdue invoices*) → 3. en_danger_critique
//   → 4. a_risque_leger → 5. champions → 6. en_expansion → 7. stables (default)
// * impayes uses score proxy — segment_memberships is the true source of truth

export const SEGMENT_FILTERS: Record<string, (a: SegmentAccountRow) => boolean> = {
  // scoring.ts: health >= 80 (priority after churn_risk checks → churn < 50)
  champions:          a => (a.health_score ?? 0) >= 80 && (a.churn_risk_score ?? 0) < 50,
  // scoring.ts: expansion >= 70 AND health >= 60 (not champion → health < 80)
  en_expansion:       a => {
    const health = a.health_score ?? 0
    return (a.expansion_score ?? 0) >= 70 && health >= 60 && health < 80 && (a.churn_risk_score ?? 0) < 50
  },
  // scoring.ts: default fallback (none of the above match)
  stables:            a => {
    const mrr = a.mrr_cents ?? 0
    const churn = a.churn_risk_score ?? 0
    const health = a.health_score ?? 0
    const expansion = a.expansion_score ?? 0
    return mrr > 0 && churn < 50 && health < 80 && !(expansion >= 70 && health >= 60)
  },
  // scoring.ts: churn_risk >= 50 AND < 70
  a_risque_leger:     a => {
    const churn = a.churn_risk_score ?? 0
    return churn >= 50 && churn < 70 && (a.mrr_cents ?? 0) > 0
  },
  // scoring.ts: churn_risk >= 70 (excludes en_churn via mrr > 0)
  en_danger_critique: a => (a.churn_risk_score ?? 0) >= 70 && (a.mrr_cents ?? 0) > 0,
  // scoring.ts: hasOverdueInvoices — proxy score (invoice data non disponible in-memory)
  // NOTE: segment_memberships est la source de verite pour ce segment
  impayes:            a => (a.churn_risk_score ?? 0) > 80 && (a.health_score ?? 100) < 50 && (a.mrr_cents ?? 0) > 0,
  // scoring.ts: mrr_cents === 0
  en_churn:           a => (a.mrr_cents ?? 0) === 0,
  // scoring.ts: created < 90 days (non-exclusif, cumule avec un segment score-based)
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
