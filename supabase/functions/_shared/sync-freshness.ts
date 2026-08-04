// ============================================================
// sync-freshness.ts — Fraîcheur de sync par provider/org
//
// Extrait de health-check/index.ts (Phase 3) pour être réutilisable par
// dashboard-api/portfolio-metrics (Phase 4) sans dupliquer le calcul — même
// principe que _shared/mrr-engine.ts : une seule implémentation.
// ============================================================
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

// sync-stripe et sync-hubspot tournent quotidiennement (CLAUDE.md) : > 48h
// = au moins 2 runs manqués consécutifs.
export const STALE_THRESHOLD_HOURS = 48

export interface SyncFreshness {
  stale: boolean
  lastSyncHoursAgo: number | null
}

export async function computeSyncFreshness(
  supabase: SupabaseClient,
  organizationId: string,
  syncSource: 'stripe' | 'hubspot',
): Promise<SyncFreshness> {
  const { data } = await supabase
    .from('data_syncs')
    .select('completed_at')
    .eq('organization_id', organizationId)
    .eq('sync_source', syncSource)
    .eq('sync_status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!data?.completed_at) {
    return { stale: true, lastSyncHoursAgo: null }
  }

  const hoursAgo = (Date.now() - new Date(data.completed_at).getTime()) / (1000 * 60 * 60)
  return { stale: hoursAgo > STALE_THRESHOLD_HOURS, lastSyncHoursAgo: Math.round(hoursAgo * 10) / 10 }
}
