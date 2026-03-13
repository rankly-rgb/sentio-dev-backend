import { describe, it, expect } from 'vitest';
import {
  validateDateRange,
  defaultStartDate,
  computeTrendSummary,
  formatMrrEur,
  formatDeltaPct,
  type MrrTrendPoint,
} from '../functions/_shared/mrr-trend-helpers';

// ─── validateDateRange ─────────────────────────────────────

describe('validateDateRange', () => {
  it('returns valid range for correct dates', () => {
    const result = validateDateRange('2026-01-01', '2026-01-31');
    expect(result).toEqual({ start: '2026-01-01', end: '2026-01-31' });
  });

  it('rejects invalid start_date format', () => {
    const result = validateDateRange('01-2026-01', '2026-01-31');
    expect('error' in result).toBe(true);
  });

  it('rejects invalid end_date format', () => {
    const result = validateDateRange('2026-01-01', 'not-a-date');
    expect('error' in result).toBe(true);
  });

  it('rejects start > end', () => {
    const result = validateDateRange('2026-03-01', '2026-02-01');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('before');
    }
  });

  it('rejects range > 365 days', () => {
    const result = validateDateRange('2025-01-01', '2026-03-01');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('365');
    }
  });

  it('accepts same day range', () => {
    const result = validateDateRange('2026-03-01', '2026-03-01');
    expect(result).toEqual({ start: '2026-03-01', end: '2026-03-01' });
  });

  it('defaults to last 30 days when null', () => {
    const result = validateDateRange(null, null);
    expect('start' in result).toBe(true);
    expect('end' in result).toBe(true);
  });

  it('accepts exactly 365 days', () => {
    const result = validateDateRange('2025-03-14', '2026-03-14');
    expect('start' in result).toBe(true);
  });
});

// ─── defaultStartDate ──────────────────────────────────────

describe('defaultStartDate', () => {
  it('returns 30 days before given date', () => {
    expect(defaultStartDate('2026-03-31')).toBe('2026-03-01');
  });

  it('handles month boundary', () => {
    expect(defaultStartDate('2026-03-15')).toBe('2026-02-13');
  });
});

// ─── computeTrendSummary ───────────────────────────────────

describe('computeTrendSummary', () => {
  it('returns zeroed summary for empty array', () => {
    const result = computeTrendSummary([]);
    expect(result.data_points).toBe(0);
    expect(result.start_mrr_cents).toBe(0);
    expect(result.end_mrr_cents).toBe(0);
    expect(result.delta_pct).toBeNull();
  });

  it('computes correct delta for growth', () => {
    const points: MrrTrendPoint[] = [
      { snapshot_date: '2026-03-01', total_mrr_cents: 100000, account_count: 10 },
      { snapshot_date: '2026-03-02', total_mrr_cents: 110000, account_count: 11 },
      { snapshot_date: '2026-03-03', total_mrr_cents: 120000, account_count: 12 },
    ];
    const result = computeTrendSummary(points);
    expect(result.start_mrr_cents).toBe(100000);
    expect(result.end_mrr_cents).toBe(120000);
    expect(result.delta_cents).toBe(20000);
    expect(result.delta_pct).toBe(20);
    expect(result.data_points).toBe(3);
  });

  it('computes negative delta for contraction', () => {
    const points: MrrTrendPoint[] = [
      { snapshot_date: '2026-03-01', total_mrr_cents: 200000, account_count: 20 },
      { snapshot_date: '2026-03-02', total_mrr_cents: 180000, account_count: 18 },
    ];
    const result = computeTrendSummary(points);
    expect(result.delta_cents).toBe(-20000);
    expect(result.delta_pct).toBe(-10);
  });

  it('returns null delta_pct when start MRR is 0', () => {
    const points: MrrTrendPoint[] = [
      { snapshot_date: '2026-03-01', total_mrr_cents: 0, account_count: 0 },
      { snapshot_date: '2026-03-02', total_mrr_cents: 50000, account_count: 5 },
    ];
    const result = computeTrendSummary(points);
    expect(result.delta_pct).toBeNull();
  });

  it('finds peak and low', () => {
    const points: MrrTrendPoint[] = [
      { snapshot_date: '2026-03-01', total_mrr_cents: 100000, account_count: 10 },
      { snapshot_date: '2026-03-02', total_mrr_cents: 150000, account_count: 15 },
      { snapshot_date: '2026-03-03', total_mrr_cents: 80000, account_count: 8 },
      { snapshot_date: '2026-03-04', total_mrr_cents: 120000, account_count: 12 },
    ];
    const result = computeTrendSummary(points);
    expect(result.peak_mrr_cents).toBe(150000);
    expect(result.low_mrr_cents).toBe(80000);
  });

  it('computes average account count', () => {
    const points: MrrTrendPoint[] = [
      { snapshot_date: '2026-03-01', total_mrr_cents: 100000, account_count: 10 },
      { snapshot_date: '2026-03-02', total_mrr_cents: 100000, account_count: 20 },
      { snapshot_date: '2026-03-03', total_mrr_cents: 100000, account_count: 30 },
    ];
    const result = computeTrendSummary(points);
    expect(result.avg_account_count).toBe(20);
  });

  it('handles single data point', () => {
    const points: MrrTrendPoint[] = [
      { snapshot_date: '2026-03-01', total_mrr_cents: 50000, account_count: 5 },
    ];
    const result = computeTrendSummary(points);
    expect(result.start_mrr_cents).toBe(50000);
    expect(result.end_mrr_cents).toBe(50000);
    expect(result.delta_cents).toBe(0);
    expect(result.delta_pct).toBe(0);
    expect(result.peak_mrr_cents).toBe(50000);
    expect(result.low_mrr_cents).toBe(50000);
  });
});

// ─── formatMrrEur ──────────────────────────────────────────

describe('formatMrrEur', () => {
  it('formats cents to euros', () => {
    // Node uses non-breaking space for fr-FR, accept both
    const result = formatMrrEur(350000);
    expect(result.replace(/\s/g, ' ')).toMatch(/3[\s.,]500/);
  });

  it('handles zero', () => {
    const result = formatMrrEur(0);
    expect(result).toContain('0');
  });
});

// ─── formatDeltaPct ────────────────────────────────────────

describe('formatDeltaPct', () => {
  it('formats positive with + sign', () => {
    expect(formatDeltaPct(12.5)).toBe('+12.5 %');
  });

  it('formats negative', () => {
    expect(formatDeltaPct(-8.3)).toBe('-8.3 %');
  });

  it('formats zero as positive', () => {
    expect(formatDeltaPct(0)).toBe('+0.0 %');
  });

  it('returns dash for null', () => {
    expect(formatDeltaPct(null)).toBe('—');
  });
});
