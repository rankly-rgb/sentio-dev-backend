import { describe, it, expect } from 'vitest'
import {
  computeHubspotStaleness,
  HUBSPOT_STALE_THRESHOLD_HOURS,
} from '../functions/_shared/hubspot-stale-helpers'

// ── Helpers ────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-03-12T12:00:00.000Z')

/** Returns a Date that is `hoursAgo` hours before FIXED_NOW. */
function syncAt(hoursAgo: number): Date {
  return new Date(FIXED_NOW.getTime() - hoursAgo * 60 * 60 * 1000)
}

// ── computeHubspotStaleness ────────────────────────────────────

describe('computeHubspotStaleness', () => {

  // ── Null input (never synced) ──────────────────────────────

  it('returns stale: true and hoursAgo: null when lastSyncAt is null', () => {
    const result = computeHubspotStaleness(null, FIXED_NOW)
    expect(result.stale).toBe(true)
    expect(result.hoursAgo).toBeNull()
  })

  // ── Fresh sync — not stale ─────────────────────────────────

  it('returns stale: false when lastSyncAt is now (0 hours ago)', () => {
    const result = computeHubspotStaleness(FIXED_NOW, FIXED_NOW)
    expect(result.stale).toBe(false)
    expect(result.hoursAgo).toBe(0)
  })

  it('returns stale: false when lastSyncAt is 47 hours ago', () => {
    const result = computeHubspotStaleness(syncAt(47), FIXED_NOW)
    expect(result.stale).toBe(false)
    expect(result.hoursAgo).toBeCloseTo(47, 5)
  })

  // ── Boundary: exactly 48h is NOT stale ────────────────────

  it('returns stale: false when lastSyncAt is exactly 48 hours ago (boundary — NOT stale)', () => {
    const result = computeHubspotStaleness(syncAt(HUBSPOT_STALE_THRESHOLD_HOURS), FIXED_NOW)
    expect(result.stale).toBe(false)
    expect(result.hoursAgo).toBe(HUBSPOT_STALE_THRESHOLD_HOURS)
  })

  // ── Just over threshold — stale ───────────────────────────

  it('returns stale: true when lastSyncAt is 48.1 hours ago (just over threshold)', () => {
    const result = computeHubspotStaleness(syncAt(48.1), FIXED_NOW)
    expect(result.stale).toBe(true)
    expect(result.hoursAgo).toBeCloseTo(48.1, 5)
  })

  it('returns stale: true when lastSyncAt is 49 hours ago', () => {
    const result = computeHubspotStaleness(syncAt(49), FIXED_NOW)
    expect(result.stale).toBe(true)
    expect(result.hoursAgo).toBeCloseTo(49, 5)
  })

  // ── hoursAgo precision ────────────────────────────────────

  it('returns decimal hours (not rounded) for precision', () => {
    // 12.5 hours ago
    const result = computeHubspotStaleness(syncAt(12.5), FIXED_NOW)
    expect(result.stale).toBe(false)
    // Should be decimal, not integer
    expect(result.hoursAgo).toBeCloseTo(12.5, 5)
    expect(Number.isInteger(result.hoursAgo)).toBe(false)
  })

})
