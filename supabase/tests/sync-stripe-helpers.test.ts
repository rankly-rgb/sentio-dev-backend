import { describe, it, expect } from 'vitest'
import { determineSyncMode } from '../functions/_shared/sync-stripe-helpers'

// ── determineSyncMode ──────────────────────────────────────────

describe('determineSyncMode', () => {
  const now = new Date('2026-03-12T12:00:00Z')

  it('returns full mode with no cursor when lastSyncCompletedAt is null', () => {
    const result = determineSyncMode(null, now)
    expect(result.mode).toBe('full')
    expect(result.cursor).toBeUndefined()
  })

  it('returns incremental mode with unix cursor when last sync was 30 minutes ago', () => {
    const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000)
    const result = determineSyncMode(thirtyMinAgo, now)
    expect(result.mode).toBe('incremental')
    expect(result.cursor).toBe(Math.floor(thirtyMinAgo.getTime() / 1000))
  })

  it('returns incremental mode at the exact 1-hour boundary (<=1h)', () => {
    const exactlyOneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)
    const result = determineSyncMode(exactlyOneHourAgo, now)
    expect(result.mode).toBe('incremental')
    expect(result.cursor).toBe(Math.floor(exactlyOneHourAgo.getTime() / 1000))
  })

  it('returns full mode when last sync was 61 minutes ago (>1h)', () => {
    const sixtyOneMinAgo = new Date(now.getTime() - 61 * 60 * 1000)
    const result = determineSyncMode(sixtyOneMinAgo, now)
    expect(result.mode).toBe('full')
    expect(result.cursor).toBeUndefined()
  })

  it('returns full mode when last sync was 24 hours ago', () => {
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const result = determineSyncMode(oneDayAgo, now)
    expect(result.mode).toBe('full')
    expect(result.cursor).toBeUndefined()
  })

  it('cursor is a unix timestamp in seconds (not milliseconds)', () => {
    const fifteenMinAgo = new Date(now.getTime() - 15 * 60 * 1000)
    const result = determineSyncMode(fifteenMinAgo, now)
    // Unix timestamp in seconds should be < 10^11 (year 5138)
    // Milliseconds would be > 10^12
    expect(result.cursor).toBeDefined()
    expect(result.cursor!).toBeLessThan(1e12)
    expect(result.cursor!).toBeGreaterThan(1e9)
  })

  it('cursor equals floor(lastSyncCompletedAt / 1000)', () => {
    const ts = new Date('2026-03-12T11:00:00.500Z') // has sub-second component
    const result = determineSyncMode(ts, now)
    expect(result.cursor).toBe(Math.floor(ts.getTime() / 1000))
  })
})
