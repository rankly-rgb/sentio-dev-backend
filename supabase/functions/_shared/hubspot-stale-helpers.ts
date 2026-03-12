// ============================================================
// HubSpot Stale Detection Helpers — Pure functions
// No Deno or JSR imports — fully testable with Vitest
// ============================================================

/** Threshold in hours after which a HubSpot sync is considered stale. */
export const HUBSPOT_STALE_THRESHOLD_HOURS = 48

/**
 * Computes the HubSpot sync staleness state given the last successful sync
 * timestamp and the current time reference.
 *
 * Boundary rule: exactly 48h is NOT stale — it must be strictly > 48h.
 *
 * @param lastSyncAt - Date of the last successful HubSpot sync, or null if
 *   the provider has never been synced.
 * @param now - Current time reference (injected for deterministic testing).
 * @returns stale flag and decimal hours since last sync (null if never synced).
 */
export function computeHubspotStaleness(
  lastSyncAt: Date | null,
  now: Date,
): { stale: boolean; hoursAgo: number | null } {
  if (lastSyncAt === null) {
    return { stale: true, hoursAgo: null }
  }

  const hoursAgo = (now.getTime() - lastSyncAt.getTime()) / (1000 * 60 * 60)

  // Strictly greater than threshold — exactly 48h is not stale
  const stale = hoursAgo > HUBSPOT_STALE_THRESHOLD_HOURS

  return { stale, hoursAgo }
}
