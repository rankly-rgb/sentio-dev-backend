// ============================================================
// Edge Function : health-check
// Returns system health status by checking DB connectivity,
// stale cron locks, and stuck syncs.
// ============================================================
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, jsonResponse, errorResponse } from '../_shared/supabase-client.ts'

interface HealthCheck {
  name: string
  status: 'ok' | 'warning' | 'critical'
  message?: string
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

  const statusCode = overallStatus === 'unhealthy' ? 503 : 200
  return jsonResponse({ status: overallStatus, checks, timestamp: new Date().toISOString() }, statusCode)
})
