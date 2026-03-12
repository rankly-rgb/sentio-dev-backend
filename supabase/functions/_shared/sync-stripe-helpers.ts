/**
 * Pure helpers for Stripe sync mode detection and URL construction.
 * No Deno/jsr imports — fully testable with Vitest.
 */

/** Sync mode result returned by determineSyncMode. */
export interface SyncModeResult {
  /** 'incremental' if last sync was within 1 hour, 'full' otherwise. */
  mode: 'incremental' | 'full'
  /** Unix timestamp (seconds) for Stripe API cursor — only set for incremental mode. */
  cursor: number | undefined
}

/**
 * Determines whether to run an incremental or full Stripe sync based on the
 * last successful sync timestamp.
 *
 * Rules:
 * - null lastSyncCompletedAt → full (no prior sync)
 * - lastSyncCompletedAt within 1 hour of now → incremental
 * - lastSyncCompletedAt more than 1 hour before now → full (data too stale)
 *
 * @param lastSyncCompletedAt - completed_at of the most recent successful data_sync, or null.
 * @param now - Reference timestamp (injected for testability, use `new Date()` in production).
 */
export function determineSyncMode(
  lastSyncCompletedAt: Date | null,
  now: Date,
): SyncModeResult {
  if (!lastSyncCompletedAt) {
    return { mode: 'full', cursor: undefined }
  }

  const hoursSinceLastSync = (now.getTime() - lastSyncCompletedAt.getTime()) / (1000 * 60 * 60)

  if (hoursSinceLastSync <= 1) {
    return {
      mode: 'incremental',
      cursor: Math.floor(lastSyncCompletedAt.getTime() / 1000),
    }
  }

  return { mode: 'full', cursor: undefined }
}
