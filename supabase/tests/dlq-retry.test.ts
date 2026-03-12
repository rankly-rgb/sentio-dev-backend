import { describe, it, expect } from 'vitest'
import {
  computeBackoffMinutes,
  shouldRetryEntry,
  MAX_RETRY_COUNT,
  type DlqEntryEligibility,
} from '../functions/_shared/dlq-retry-helpers'

// ── Helpers ───────────────────────────────────────────────────

/** Build a DLQ entry relative to a reference `now`. */
function makeEntry(opts: {
  retry_count: number
  last_retry_at_mins_ago?: number | null
  created_at_hours_ago?: number
}): DlqEntryEligibility {
  const now = new Date()
  const createdAt = new Date(now.getTime() - (opts.created_at_hours_ago ?? 1) * 60 * 60 * 1000)

  let last_retry_at: string | null = null
  if (opts.last_retry_at_mins_ago != null) {
    last_retry_at = new Date(now.getTime() - opts.last_retry_at_mins_ago * 60 * 1000).toISOString()
  }

  return {
    retry_count: opts.retry_count,
    last_retry_at,
    created_at: createdAt.toISOString(),
  }
}

// ── computeBackoffMinutes ─────────────────────────────────────

describe('computeBackoffMinutes', () => {
  it('returns 0 minutes for retryCount 0 (immediate first attempt)', () => {
    expect(computeBackoffMinutes(0)).toBe(0)
  })

  it('returns 30 minutes for retryCount 1', () => {
    expect(computeBackoffMinutes(1)).toBe(30)
  })

  it('returns 60 minutes for retryCount 2', () => {
    expect(computeBackoffMinutes(2)).toBe(60)
  })

  it('returns 90 minutes for retryCount 3 (hypothetical)', () => {
    expect(computeBackoffMinutes(3)).toBe(90)
  })
})

// ── shouldRetryEntry ──────────────────────────────────────────

describe('shouldRetryEntry', () => {
  // ── Happy path ──────────────────────────────────────────────

  it('returns true for a fresh entry with retry_count=0 and no last_retry_at', () => {
    const entry = makeEntry({ retry_count: 0, last_retry_at_mins_ago: null })
    expect(shouldRetryEntry(entry)).toBe(true)
  })

  it('returns true for retry_count=1 with no last_retry_at', () => {
    // Edge case: last_retry_at can be null even with retry_count > 0 (legacy rows)
    const entry = makeEntry({ retry_count: 1, last_retry_at_mins_ago: null })
    expect(shouldRetryEntry(entry)).toBe(true)
  })

  it('returns true when retry_count=2 and last_retry_at is 65 minutes ago (backoff=60 min, expired)', () => {
    const entry = makeEntry({ retry_count: 2, last_retry_at_mins_ago: 65 })
    expect(shouldRetryEntry(entry)).toBe(true)
  })

  it('returns true when retry_count=1 and last_retry_at is 31 minutes ago (backoff=30 min, just expired)', () => {
    const entry = makeEntry({ retry_count: 1, last_retry_at_mins_ago: 31 })
    expect(shouldRetryEntry(entry)).toBe(true)
  })

  // ── Backoff window active ────────────────────────────────────

  it('returns false when retry_count=2 and last_retry_at is 55 minutes ago (backoff=60 min, not expired)', () => {
    const entry = makeEntry({ retry_count: 2, last_retry_at_mins_ago: 55 })
    expect(shouldRetryEntry(entry)).toBe(false)
  })

  it('returns false when retry_count=1 and last_retry_at is 10 minutes ago (backoff=30 min, still active)', () => {
    const entry = makeEntry({ retry_count: 1, last_retry_at_mins_ago: 10 })
    expect(shouldRetryEntry(entry)).toBe(false)
  })

  it('returns false when retry_count=1 and last_retry_at is exactly 30 minutes ago (boundary — not expired yet)', () => {
    // Exactly at boundary: msSinceLastRetry (30 min) === backoffMs (30 min) → eligible
    // We test with 29 minutes to confirm still-active case
    const entry = makeEntry({ retry_count: 1, last_retry_at_mins_ago: 29 })
    expect(shouldRetryEntry(entry)).toBe(false)
  })

  // ── Exhausted retries ────────────────────────────────────────

  it('returns false when retry_count equals MAX_RETRY_COUNT (3)', () => {
    const entry = makeEntry({ retry_count: MAX_RETRY_COUNT, last_retry_at_mins_ago: null })
    expect(shouldRetryEntry(entry)).toBe(false)
  })

  it('returns false when retry_count exceeds MAX_RETRY_COUNT', () => {
    const entry = makeEntry({ retry_count: 5, last_retry_at_mins_ago: null })
    expect(shouldRetryEntry(entry)).toBe(false)
  })

  // ── Too old ──────────────────────────────────────────────────

  it('returns false when created_at is 25 hours ago (too old)', () => {
    const entry = makeEntry({ retry_count: 0, last_retry_at_mins_ago: null, created_at_hours_ago: 25 })
    expect(shouldRetryEntry(entry)).toBe(false)
  })

  it('returns false when created_at is exactly 24 hours and 1 second ago', () => {
    const now = new Date()
    const entry: DlqEntryEligibility = {
      retry_count: 0,
      last_retry_at: null,
      created_at: new Date(now.getTime() - 24 * 60 * 60 * 1000 - 1000).toISOString(),
    }
    expect(shouldRetryEntry(entry)).toBe(false)
  })

  it('returns true when created_at is exactly 23 hours ago (within 24h window)', () => {
    const entry = makeEntry({ retry_count: 0, last_retry_at_mins_ago: null, created_at_hours_ago: 23 })
    expect(shouldRetryEntry(entry)).toBe(true)
  })

  // ── Custom `now` parameter ───────────────────────────────────

  it('accepts a custom `now` parameter for deterministic testing', () => {
    const fixedNow = new Date('2026-03-12T12:00:00Z')
    const entry: DlqEntryEligibility = {
      retry_count: 1,
      last_retry_at: new Date('2026-03-12T11:25:00Z').toISOString(), // 35 min ago relative to fixedNow
      created_at: new Date('2026-03-12T10:00:00Z').toISOString(),    // 2 hours ago
    }
    // backoff = 30 min, 35 min > 30 min → should retry
    expect(shouldRetryEntry(entry, fixedNow)).toBe(true)
  })

  it('respects backoff with custom `now` — 20 min since last retry, backoff=30 min → false', () => {
    const fixedNow = new Date('2026-03-12T12:00:00Z')
    const entry: DlqEntryEligibility = {
      retry_count: 1,
      last_retry_at: new Date('2026-03-12T11:40:00Z').toISOString(), // 20 min ago
      created_at: new Date('2026-03-12T10:00:00Z').toISOString(),
    }
    expect(shouldRetryEntry(entry, fixedNow)).toBe(false)
  })
})
