// ============================================================
// Edge Function : self-monitor
// Auto-recovery cron: detects stuck syncs, expired locks,
// DLQ growth, and scoring staleness. Sends Slack alerts.
// Should be called every 15 minutes via Supabase cron.
// ============================================================
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, jsonResponse, errorResponse } from '../_shared/supabase-client.ts'
import { alertSlack } from '../_shared/slack-alert.ts'

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'self-monitor', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const actions: string[] = []

  // 1. Auto-fail stuck running syncs (> 15 min)
  try {
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    const { data: stuckSyncs } = await supabase
      .from('data_syncs')
      .select('id, sync_source, organization_id, started_at')
      .eq('sync_status', 'running')
      .lt('started_at', fifteenMinAgo)

    if (stuckSyncs && stuckSyncs.length > 0) {
      for (const sync of stuckSyncs) {
        await supabase
          .from('data_syncs')
          .update({
            sync_status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: 'Auto-failed by self-monitor: exceeded 15 min running time',
            error_type: 'timeout',
            is_retryable: true,
          })
          .eq('id', sync.id)

        actions.push(`Auto-failed stuck sync ${sync.id} (${sync.sync_source})`)
      }

      await alertSlack(
        `self-monitor: auto-failed ${stuckSyncs.length} stuck sync(s)`,
        { level: 'warning' },
      )
    }
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'self-monitor',
      message: 'Failed to check stuck syncs',
      error: err instanceof Error ? err.message : String(err),
    }))
  }

  // 2. Auto-release expired cron locks
  try {
    const { data: expiredLocks } = await supabase
      .from('cron_locks')
      .select('id, lock_key, expires_at')
      .lt('expires_at', new Date().toISOString())

    if (expiredLocks && expiredLocks.length > 0) {
      for (const lock of expiredLocks) {
        await supabase
          .from('cron_locks')
          .delete()
          .eq('id', lock.id)

        actions.push(`Released expired lock: ${lock.lock_key}`)
      }

      await alertSlack(
        `self-monitor: released ${expiredLocks.length} expired cron lock(s)`,
        { level: 'info' },
      )
    }
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'self-monitor',
      message: 'Failed to check expired locks',
      error: err instanceof Error ? err.message : String(err),
    }))
  }

  // 3. Check DLQ growth in last hour
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { data: dlqEntries } = await supabase
      .from('webhook_dead_letter')
      .select('id')
      .gte('created_at', oneHourAgo)
      .is('resolved_at', null)

    const count = dlqEntries?.length ?? 0
    if (count > 20) {
      await alertSlack(
        `self-monitor: ${count} unresolved DLQ entries in last hour (critical threshold)`,
        { level: 'critical' },
      )
      actions.push(`DLQ alert: ${count} entries (critical)`)
    } else if (count > 5) {
      await alertSlack(
        `self-monitor: ${count} unresolved DLQ entries in last hour`,
        { level: 'warning' },
      )
      actions.push(`DLQ alert: ${count} entries (warning)`)
    }
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'self-monitor',
      message: 'Failed to check DLQ',
      error: err instanceof Error ? err.message : String(err),
    }))
  }

  // 4. Check scoring freshness (last score_history entry)
  try {
    const { data: lastScore } = await supabase
      .from('score_history')
      .select('snapshot_date')
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .single()

    if (lastScore?.snapshot_date) {
      const ageMs = Date.now() - new Date(lastScore.snapshot_date).getTime()
      const ageHours = ageMs / (60 * 60 * 1000)

      if (ageHours > 48) {
        await alertSlack(
          `self-monitor: scoring is stale — last snapshot is ${Math.round(ageHours)}h old (critical)`,
          { level: 'critical' },
        )
        actions.push(`Scoring stale: ${Math.round(ageHours)}h old`)
      } else if (ageHours > 26) {
        await alertSlack(
          `self-monitor: scoring may be stale — last snapshot is ${Math.round(ageHours)}h old`,
          { level: 'warning' },
        )
        actions.push(`Scoring stale: ${Math.round(ageHours)}h old`)
      }
    }
  } catch {
    // No score_history data yet — expected in early setup
  }

  // 5. Check recent sync failures
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { data: recentFailures } = await supabase
      .from('data_syncs')
      .select('id')
      .eq('sync_status', 'failed')
      .gte('completed_at', oneHourAgo)

    const failCount = recentFailures?.length ?? 0
    if (failCount > 5) {
      await alertSlack(
        `self-monitor: ${failCount} sync failures in last hour (critical)`,
        { level: 'critical' },
      )
      actions.push(`Sync failures: ${failCount} (critical)`)
    } else if (failCount > 2) {
      await alertSlack(
        `self-monitor: ${failCount} sync failures in last hour`,
        { level: 'warning' },
      )
      actions.push(`Sync failures: ${failCount} (warning)`)
    }
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'self-monitor',
      message: 'Failed to check sync failures',
      error: err instanceof Error ? err.message : String(err),
    }))
  }

  return jsonResponse({
    success: true,
    actions_taken: actions.length,
    actions,
    timestamp: new Date().toISOString(),
  })
})
