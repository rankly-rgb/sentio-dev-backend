import { describe, it, expect } from 'vitest'

// ── Mirror of prefetchInsightData's usageHistoryMap loop
// (generate-insights/index.ts) — that file imports jsr: specifiers
// (Deno edge-runtime types, supabase-js) Vitest/Node cannot resolve, same
// convention as calculate-scores-churn.test.ts. Covers the bug fixed
// 2026-08-04 (AUDIT_LOGIQUE_METIER_STRIPE.md point 19): a row with
// product_usage_score=null used to leave the account "unvisited", letting
// the loop fall through to an older, stale row instead of treating the
// null as "no recent data". ────────────────────────────────────────────

interface ScoreHistoryRow {
  account_id: string
  product_usage_score: number | null
}

function buildUsageHistoryMap(rows: ScoreHistoryRow[]): Map<string, number> {
  const usageHistoryMap = new Map<string, number>()
  const visitedAccounts = new Set<string>()
  for (const row of rows) {
    if (visitedAccounts.has(row.account_id)) continue
    visitedAccounts.add(row.account_id)
    if (row.product_usage_score !== null) {
      usageHistoryMap.set(row.account_id, row.product_usage_score)
    }
  }
  return usageHistoryMap
}

describe('buildUsageHistoryMap (fixed loop)', () => {
  it('uses the most recent non-null score when the first row has one', () => {
    const map = buildUsageHistoryMap([
      { account_id: 'a1', product_usage_score: 62 },
      { account_id: 'a1', product_usage_score: 40 }, // older, must be ignored
    ])
    expect(map.get('a1')).toBe(62)
  })

  it('REGRESSION: a null most-recent row is NOT skipped in favor of an older non-null row', () => {
    const map = buildUsageHistoryMap([
      { account_id: 'a1', product_usage_score: null }, // most recent (post-v3-cutover, frozen column)
      { account_id: 'a1', product_usage_score: 88 }, // older, pre-cutover — must NOT be surfaced as "recent"
    ])
    expect(map.has('a1')).toBe(false)
  })

  it('accounts are independent — one account falling through to null does not affect another', () => {
    const map = buildUsageHistoryMap([
      { account_id: 'a1', product_usage_score: null },
      { account_id: 'a2', product_usage_score: 55 },
      { account_id: 'a1', product_usage_score: 90 },
    ])
    expect(map.has('a1')).toBe(false)
    expect(map.get('a2')).toBe(55)
  })

  it('empty input yields an empty map', () => {
    expect(buildUsageHistoryMap([]).size).toBe(0)
  })
})
