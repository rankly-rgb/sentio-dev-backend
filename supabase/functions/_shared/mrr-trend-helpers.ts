/**
 * MRR Trend helpers — pure functions for formatting and validation.
 * No Deno/jsr imports, testable with Vitest.
 */

// ---------- Types ----------

export interface MrrTrendPoint {
  snapshot_date: string;  // 'YYYY-MM-DD'
  total_mrr_cents: number;
  account_count: number;
}

export interface MrrMovementPoint {
  movement_date: string;  // 'YYYY-MM-DD'
  new_mrr_cents: number;
  expansion_mrr_cents: number;
  contraction_mrr_cents: number;
  churn_mrr_cents: number;
  reactivation_mrr_cents: number;
  net_mrr_cents: number;
}

export interface MrrTrendSummary {
  start_mrr_cents: number;
  end_mrr_cents: number;
  delta_cents: number;
  delta_pct: number | null;  // null if start = 0
  peak_mrr_cents: number;
  low_mrr_cents: number;
  avg_account_count: number;
  data_points: number;
}

// ---------- Validation ----------

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 365;

export function validateDateRange(
  startDate: string | null | undefined,
  endDate: string | null | undefined
): { start: string; end: string } | { error: string } {
  const today = new Date().toISOString().slice(0, 10);
  const start = startDate || defaultStartDate(today);
  const end = endDate || today;

  if (!DATE_REGEX.test(start)) {
    return { error: `Invalid start_date format: ${start}` };
  }
  if (!DATE_REGEX.test(end)) {
    return { error: `Invalid end_date format: ${end}` };
  }
  if (start > end) {
    return { error: 'start_date must be before or equal to end_date' };
  }

  const diffDays = Math.ceil(
    (new Date(end).getTime() - new Date(start).getTime()) / (1000 * 60 * 60 * 24)
  );
  if (diffDays > MAX_RANGE_DAYS) {
    return { error: `Date range exceeds ${MAX_RANGE_DAYS} days` };
  }

  return { start, end };
}

/** Default: 30 days before the given date */
export function defaultStartDate(endDate: string): string {
  const d = new Date(endDate);
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

// ---------- Summary ----------

export function computeTrendSummary(points: MrrTrendPoint[]): MrrTrendSummary {
  if (points.length === 0) {
    return {
      start_mrr_cents: 0,
      end_mrr_cents: 0,
      delta_cents: 0,
      delta_pct: null,
      peak_mrr_cents: 0,
      low_mrr_cents: 0,
      avg_account_count: 0,
      data_points: 0,
    };
  }

  const startMrr = points[0].total_mrr_cents;
  const endMrr = points[points.length - 1].total_mrr_cents;
  const delta = endMrr - startMrr;
  const deltaPct = startMrr > 0 ? Math.round((delta / startMrr) * 10000) / 100 : null;

  let peak = points[0].total_mrr_cents;
  let low = points[0].total_mrr_cents;
  let totalAccounts = 0;

  for (const p of points) {
    if (p.total_mrr_cents > peak) peak = p.total_mrr_cents;
    if (p.total_mrr_cents < low) low = p.total_mrr_cents;
    totalAccounts += p.account_count;
  }

  return {
    start_mrr_cents: startMrr,
    end_mrr_cents: endMrr,
    delta_cents: delta,
    delta_pct: deltaPct,
    peak_mrr_cents: peak,
    low_mrr_cents: low,
    avg_account_count: Math.round(totalAccounts / points.length),
    data_points: points.length,
  };
}

// ---------- Formatting ----------

export function formatMrrEur(cents: number): string {
  return (cents / 100).toLocaleString('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

export function formatDeltaPct(pct: number | null): string {
  if (pct === null) return '—';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)} %`;
}
