// Logique pure de détection de dérive pour reconciliation-check.
// Compare le cache dénormalisé account_segments.account_count au
// comptage live de segment_memberships (status='active').

const CRITICAL_ABS_THRESHOLD = 5
const CRITICAL_PCT_THRESHOLD = 0.1

export interface SegmentCount {
  segment_type: string
  cached: number
  live: number
}

export interface DriftEntry extends SegmentCount {
  diff: number
  severity: 'warning' | 'critical'
}

export function findDrift(segments: SegmentCount[]): DriftEntry[] {
  const drifts: DriftEntry[] = []

  for (const s of segments) {
    const diff = s.live - s.cached
    if (diff === 0) continue

    const pct = s.cached > 0 ? Math.abs(diff) / s.cached : Math.abs(diff) > 0 ? 1 : 0
    const severity: 'warning' | 'critical' =
      Math.abs(diff) > CRITICAL_ABS_THRESHOLD || pct > CRITICAL_PCT_THRESHOLD ? 'critical' : 'warning'

    drifts.push({ ...s, diff, severity })
  }

  return drifts
}
