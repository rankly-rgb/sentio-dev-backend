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

// Lot 3 (2026-08-13, diagnostic webhook Stripe) : distinct de
// computeSyncFreshness — une org sans aucun webhook_receipts pour son
// organization_id n'a jamais eu d'event Stripe résolu à son compte, ce qui
// est un état normal pour une org dont l'endpoint webhook n'a simplement
// jamais reçu de trafic (pas encore configuré côté Stripe) — pas
// nécessairement une panne, contrairement à un sync batch qui tourne en
// cron et DOIT produire un résultat régulier. `webhookNeverReceived: true`
// distingue explicitement ce cas de "stale" (a déjà reçu, mais il y a
// longtemps).
export interface WebhookFreshness {
  webhookNeverReceived: boolean
  lastWebhookReceivedHoursAgo: number | null
}

export async function computeWebhookFreshness(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<WebhookFreshness> {
  const { data } = await supabase
    .from('webhook_receipts')
    .select('received_at')
    .eq('organization_id', organizationId)
    .eq('signature_valid', true)
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!data?.received_at) {
    return { webhookNeverReceived: true, lastWebhookReceivedHoursAgo: null }
  }

  const hoursAgo = (Date.now() - new Date(data.received_at).getTime()) / (1000 * 60 * 60)
  return { webhookNeverReceived: false, lastWebhookReceivedHoursAgo: Math.round(hoursAgo * 10) / 10 }
}
