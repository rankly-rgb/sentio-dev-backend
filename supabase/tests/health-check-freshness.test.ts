import { describe, it, expect } from 'vitest'

// ── Mirror of computeSyncFreshness's pure math (health-check/index.ts) —
// jsr:-dependent file, same convention as calculate-scores-churn.test.ts.
// docs/openspec.md Phase 3: stripe_stale mirrors hubspot_stale exactly. ──

const STALE_THRESHOLD_HOURS = 48

function freshnessFromCompletedAt(completedAt: string | null, now: number): { stale: boolean; lastSyncHoursAgo: number | null } {
  if (!completedAt) return { stale: true, lastSyncHoursAgo: null }
  const hoursAgo = (now - new Date(completedAt).getTime()) / (1000 * 60 * 60)
  return { stale: hoursAgo > STALE_THRESHOLD_HOURS, lastSyncHoursAgo: Math.round(hoursAgo * 10) / 10 }
}

describe('computeSyncFreshness math (stripe_stale mirrors hubspot_stale)', () => {
  const now = new Date('2026-08-04T12:00:00Z').getTime()

  it('never synced (completed_at null) → stale=true, hours=null', () => {
    expect(freshnessFromCompletedAt(null, now)).toEqual({ stale: true, lastSyncHoursAgo: null })
  })

  it('synced 1 hour ago → not stale', () => {
    const result = freshnessFromCompletedAt(new Date(now - 1 * 3600_000).toISOString(), now)
    expect(result.stale).toBe(false)
    expect(result.lastSyncHoursAgo).toBe(1)
  })

  it('synced exactly 48h ago → not stale (threshold is strictly >48h)', () => {
    const result = freshnessFromCompletedAt(new Date(now - 48 * 3600_000).toISOString(), now)
    expect(result.stale).toBe(false)
  })

  it('synced 49h ago → stale', () => {
    const result = freshnessFromCompletedAt(new Date(now - 49 * 3600_000).toISOString(), now)
    expect(result.stale).toBe(true)
    expect(result.lastSyncHoursAgo).toBe(49)
  })

  it('synced 100 days ago → stale, hours_ago still a real (large) number, not clamped', () => {
    const result = freshnessFromCompletedAt(new Date(now - 100 * 24 * 3600_000).toISOString(), now)
    expect(result.stale).toBe(true)
    expect(result.lastSyncHoursAgo).toBe(2400)
  })
})
