// ============================================================
// Edge Function : health-check
// Returns system health status by checking DB connectivity,
// stale cron locks, and stuck syncs.
// ============================================================
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, jsonResponse, errorResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth } from '../_shared/auth.ts'

interface HealthCheck {
  name: string
  status: 'ok' | 'warning' | 'critical'
  message?: string
}

// Seuil de fraîcheur (docs/openspec.md Phase 3, miroir du contrat frontend
// déjà déclaré — src/types/ops.ts HealthCheckResponse.hubspot_stale —
// jamais réellement peuplé côté backend avant ce chantier). sync-stripe et
// sync-hubspot tournent quotidiennement (CLAUDE.md) : > 48h = au moins
// 2 runs manqués consécutifs.
const STALE_THRESHOLD_HOURS = 48

interface SyncFreshness {
  stale: boolean
  lastSyncHoursAgo: number | null
}

async function computeSyncFreshness(
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

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'GET' && req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch {
    return jsonResponse({ status: 'unhealthy', checks: [{ name: 'config', status: 'critical', message: 'Missing env vars' }] }, 500)
  }

  const checks: HealthCheck[] = []
  let overallStatus: 'ok' | 'degraded' | 'unhealthy' = 'ok'

  // Check 1: DB connectivity
  try {
    const { error } = await supabase.from('organizations').select('id').limit(1)
    if (error) {
      checks.push({ name: 'database', status: 'critical', message: error.message })
      overallStatus = 'unhealthy'
    } else {
      checks.push({ name: 'database', status: 'ok' })
    }
  } catch (err) {
    checks.push({ name: 'database', status: 'critical', message: err instanceof Error ? err.message : 'Unknown error' })
    overallStatus = 'unhealthy'
  }

  // Check 2: Stale cron locks (acquired > 10 min ago)
  try {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const { data: staleLocks } = await supabase
      .from('cron_locks')
      .select('lock_key, locked_at')
      .lt('expires_at', new Date().toISOString())

    if (staleLocks && staleLocks.length > 0) {
      const lockNames = staleLocks.map((l: { lock_key: string }) => l.lock_key).join(', ')
      checks.push({ name: 'cron_locks', status: 'warning', message: `Expired locks: ${lockNames}` })
      if (overallStatus === 'ok') overallStatus = 'degraded'
    } else {
      checks.push({ name: 'cron_locks', status: 'ok' })
    }
  } catch {
    checks.push({ name: 'cron_locks', status: 'warning', message: 'Could not check cron locks' })
  }

  // Check 3: Stuck running syncs (> 15 min)
  try {
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    const { data: stuckSyncs } = await supabase
      .from('data_syncs')
      .select('id, sync_source, started_at')
      .eq('sync_status', 'running')
      .lt('started_at', fifteenMinAgo)

    if (stuckSyncs && stuckSyncs.length > 0) {
      checks.push({ name: 'data_syncs', status: 'warning', message: `${stuckSyncs.length} stuck sync(s)` })
      if (overallStatus === 'ok') overallStatus = 'degraded'
    } else {
      checks.push({ name: 'data_syncs', status: 'ok' })
    }
  } catch {
    checks.push({ name: 'data_syncs', status: 'warning', message: 'Could not check data syncs' })
  }

  // Check 4: DLQ entries in last hour
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { data: dlqEntries, error: dlqError } = await supabase
      .from('webhook_dead_letter')
      .select('id')
      .gte('created_at', oneHourAgo)
      .is('resolved_at', null)

    if (!dlqError && dlqEntries && dlqEntries.length > 20) {
      checks.push({ name: 'dlq', status: 'critical', message: `${dlqEntries.length} unresolved DLQ entries in last hour` })
      overallStatus = 'unhealthy'
    } else if (!dlqError && dlqEntries && dlqEntries.length > 5) {
      checks.push({ name: 'dlq', status: 'warning', message: `${dlqEntries.length} unresolved DLQ entries in last hour` })
      if (overallStatus === 'ok') overallStatus = 'degraded'
    } else {
      checks.push({ name: 'dlq', status: 'ok' })
    }
  } catch {
    checks.push({ name: 'dlq', status: 'warning', message: 'Could not check DLQ' })
  }

  // Fraîcheur de sync par org (docs/openspec.md Phase 3) — endpoint
  // volontairement appelable sans JWT (moniteur externe existant), un JWT
  // valide ajoute simplement les champs *_stale/*_sync_hours_ago pour
  // l'org résolue. stripe_stale mirrore exactement hubspot_stale, jusque-là
  // déclaré côté frontend (src/types/ops.ts) mais jamais réellement peuplé.
  let freshnessFields: Record<string, boolean | number | null> = {}
  try {
    const { organizationId } = await verifyUserAuth(req)
    const [stripeFreshness, hubspotFreshness] = await Promise.all([
      computeSyncFreshness(supabase, organizationId, 'stripe'),
      computeSyncFreshness(supabase, organizationId, 'hubspot'),
    ])
    freshnessFields = {
      stripe_stale: stripeFreshness.stale,
      last_stripe_sync_hours_ago: stripeFreshness.lastSyncHoursAgo,
      hubspot_stale: hubspotFreshness.stale,
      last_hubspot_sync_hours_ago: hubspotFreshness.lastSyncHoursAgo,
    }
  } catch {
    // Pas de JWT (ou invalide) — comportement inchangé pour les moniteurs
    // externes non authentifiés, champs de fraîcheur simplement absents.
  }

  const statusCode = overallStatus === 'unhealthy' ? 503 : 200
  return jsonResponse({ status: overallStatus, checks, timestamp: new Date().toISOString(), ...freshnessFields }, statusCode)
})
