// ============================================================
// DLQ Retry Helpers — Pure functions for dead letter queue retry logic
// No Deno or JSR imports — fully testable with Vitest
// ============================================================

/** Backoff window per retry attempt: retryCount × 30 minutes */
export const BACKOFF_MINUTES_PER_RETRY = 30

/** Maximum retry attempts before giving up */
export const MAX_RETRY_COUNT = 3

/** Maximum age of a DLQ entry before it is skipped (ms) */
export const MAX_ENTRY_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

/**
 * Computes the backoff window in minutes for a given retry count.
 *
 * - retryCount 0 → 0 min  (dispatch immediately on first attempt)
 * - retryCount 1 → 30 min (wait 30 min before second attempt)
 * - retryCount 2 → 60 min (wait 60 min before third attempt)
 */
export function computeBackoffMinutes(retryCount: number): number {
  return retryCount * BACKOFF_MINUTES_PER_RETRY
}

export interface DlqEntryEligibility {
  retry_count: number
  last_retry_at: string | null
  created_at: string
}

/**
 * Determines whether a DLQ entry is eligible for a replay attempt.
 *
 * Returns false when any of the following is true:
 * - retry_count >= MAX_RETRY_COUNT (exhausted)
 * - created_at is older than 24 hours (too old to replay)
 * - last_retry_at is within the current backoff window
 *
 * Returns true when the entry is fresh, has attempts remaining, and the
 * backoff window has expired.
 */
export function shouldRetryEntry(
  entry: DlqEntryEligibility,
  now: Date = new Date(),
): boolean {
  // Exhausted: no more attempts allowed
  if (entry.retry_count >= MAX_RETRY_COUNT) return false

  // Too old: skip entries older than 24 h to avoid replaying stale data
  const createdAt = new Date(entry.created_at)
  if (now.getTime() - createdAt.getTime() > MAX_ENTRY_AGE_MS) return false

  // Backoff: first attempt (retry_count === 0 and no last_retry_at) → always retry
  if (entry.last_retry_at === null) return true

  const backoffMs = computeBackoffMinutes(entry.retry_count) * 60 * 1000
  const lastRetry = new Date(entry.last_retry_at)
  const msSinceLastRetry = now.getTime() - lastRetry.getTime()

  // Still within the backoff window — do not retry yet
  return msSinceLastRetry >= backoffMs
}
