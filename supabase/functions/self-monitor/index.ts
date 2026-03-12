// ============================================================
// Edge Function : self-monitor
// Auto-recovery cron: detects stuck syncs, expired locks,
// DLQ growth, and scoring staleness. Sends Slack alerts.
// Should be called every 15 minutes via Supabase cron.
// ============================================================
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, jsonResponse, errorResponse } from '../_shared/supabase-client.ts'
import { acquireCronLock, releaseCronLock } from '../_shared/cron-lock.ts'
import { alertSlack } from '../_shared/slack-alert.ts'
import { shouldRetryEntry } from '../_shared/dlq-retry-helpers.ts'
import { dispatchWebhook } from '../_shared/webhook-dispatcher.ts'
import { computeHubspotStaleness } from '../_shared/hubspot-stale-helpers.ts'
import { createHubSpotTask, associateTaskToCompany } from '../_shared/hubspot-actions.ts'
import { getVaultSecret } from '../_shared/vault.ts'

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

  // Prevent concurrent self-monitor runs
  const lockAcquired = await acquireCronLock(supabase, 'self-monitor', 120)
  if (!lockAcquired) {
    return jsonResponse({ success: true, skipped: true, reason: 'already_running' })
  }

  const actions: string[] = []

  try {

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
      .maybeSingle()

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

  // 5. Auto-fail stuck playbook executions (> 15 min)
  try {
    const fifteenMinAgo2 = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    const { data: stuckExecs } = await supabase
      .from('playbook_executions')
      .select('id, playbook_id, account_id')
      .eq('execution_status', 'running')
      .lt('started_at', fifteenMinAgo2)

    if (stuckExecs && stuckExecs.length > 0) {
      for (const exec of stuckExecs) {
        await supabase
          .from('playbook_executions')
          .update({
            execution_status: 'failed',
            completed_at: new Date().toISOString(),
          })
          .eq('id', exec.id)

        actions.push(`Auto-failed stuck execution ${exec.id} (playbook ${exec.playbook_id})`)
      }

      await alertSlack(
        `self-monitor: auto-failed ${stuckExecs.length} stuck playbook execution(s)`,
        { level: 'warning' },
      )
    }
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'self-monitor',
      message: 'Failed to check stuck playbook executions',
      error: err instanceof Error ? err.message : String(err),
    }))
  }

  // 6. Clean old DLQ entries (> 30 days)
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data: oldDlq } = await supabase
      .from('webhook_dead_letter')
      .select('id')
      .lt('created_at', thirtyDaysAgo)
      .limit(500)

    if (oldDlq && oldDlq.length > 0) {
      const ids = oldDlq.map((d: { id: string }) => d.id)
      await supabase
        .from('webhook_dead_letter')
        .delete()
        .in('id', ids)

      actions.push(`Cleaned ${oldDlq.length} old DLQ entries (> 30 days)`)
    }
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'self-monitor',
      message: 'Failed to clean old DLQ entries',
      error: err instanceof Error ? err.message : String(err),
    }))
  }

  // 7. Check recent sync failures
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

  // 8. DLQ Replay — attempt to re-dispatch failed webhook entries
  try {
    const now = new Date()
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

    // Fetch candidates: not exhausted and created within the last 24h.
    // Backoff filtering is applied in-memory via shouldRetryEntry() so that the
    // pure function remains testable without SQL-level filtering.
    const { data: dlqCandidates } = await supabase
      .from('webhook_dead_letter')
      .select('id, provider, payload, event_type, error_message, retry_count, last_retry_at, organization_id, created_at')
      .lt('retry_count', 3)
      .gte('created_at', twentyFourHoursAgo)
      .is('resolved_at', null)
      .limit(20)

    let dlqReplayed = 0
    let dlqFailed = 0

    for (const entry of (dlqCandidates ?? [])) {
      // Apply backoff filter in-memory using the pure helper
      if (!shouldRetryEntry(entry, now)) continue

      try {
        if (entry.provider === 'outbound_webhook') {
          // Re-dispatch outbound webhook using the full dispatcher which
          // fetches the org's active config, signs the payload, and sends it.
          const raw = typeof entry.payload === 'string' ? JSON.parse(entry.payload) : entry.payload
          const account = raw?.account ?? {}
          const signals = raw?.signals ?? {}
          const event = entry.event_type ?? 'health_score_drop'

          await dispatchWebhook(
            supabase,
            entry.organization_id,
            event,
            account,
            signals,
          )

          // Remove successfully replayed entry from DLQ
          await supabase.from('webhook_dead_letter').delete().eq('id', entry.id)
          dlqReplayed++
        } else if (entry.provider === 'hubspot') {
          // Re-attempt HubSpot task creation from DLQ payload
          const raw = typeof entry.payload === 'string' ? JSON.parse(entry.payload) : entry.payload
          const orgId = entry.organization_id
          const hubspotCompanyId = raw?.hubspot_company_id as string | undefined
          const taskTitle = (raw?.task_title as string) ?? 'Tache Sentio'
          const taskBody = (raw?.task_body as string) ?? 'Tache creee par Sentio AI'
          const taskDueDays = (raw?.task_due_days as number) ?? 3

          // Resolve HubSpot token from Vault via organization_integrations
          const { data: hsIntegration } = await supabase
            .from('organization_integrations')
            .select('vault_access_token_id')
            .eq('organization_id', orgId)
            .eq('provider', 'hubspot')
            .eq('is_active', true)
            .maybeSingle()

          if (!hsIntegration?.vault_access_token_id) {
            throw new Error('HubSpot integration not found or inactive for org')
          }

          const hsToken = await getVaultSecret(supabase, hsIntegration.vault_access_token_id)
          if (!hsToken) {
            throw new Error('HubSpot token not found in Vault')
          }

          const taskResult = await createHubSpotTask(hsToken, {
            title: taskTitle,
            body: taskBody,
            dueDays: taskDueDays,
          })

          // Associate task to company if hubspot_company_id is available
          if (hubspotCompanyId) {
            try {
              await associateTaskToCompany(hsToken, taskResult.taskId, hubspotCompanyId)
            } catch {
              // Association failure is non-critical — task was created successfully
              console.error(JSON.stringify({
                level: 'warn',
                function_name: 'self-monitor',
                message: 'HubSpot DLQ replay: task created but association failed',
                dlq_entry_id: entry.id,
                task_id: taskResult.taskId,
                company_id: hubspotCompanyId,
              }))
            }
          }

          // Remove successfully replayed entry from DLQ
          await supabase.from('webhook_dead_letter').delete().eq('id', entry.id)
          dlqReplayed++
        } else {
          // Non-replayable providers (stripe, usage) cannot be re-dispatched
          // without their original signed body. Exhaust their retries gracefully
          // so they do not block the queue indefinitely.
          const newCount = (entry.retry_count ?? 0) + 1
          await supabase
            .from('webhook_dead_letter')
            .update({ retry_count: newCount, last_retry_at: now.toISOString() })
            .eq('id', entry.id)

          if (newCount >= 3) {
            await alertSlack(
              `self-monitor: DLQ entry max retries reached | id: ${entry.id} | provider: ${entry.provider} | error: ${entry.error_message}`,
              { level: 'warning' },
            )
          }

          dlqFailed++
        }
      } catch (replayErr) {
        // Re-dispatch failed — increment retry_count and record timestamp
        const newCount = (entry.retry_count ?? 0) + 1
        await supabase
          .from('webhook_dead_letter')
          .update({ retry_count: newCount, last_retry_at: now.toISOString() })
          .eq('id', entry.id)

        if (newCount >= 3) {
          await alertSlack(
            `self-monitor: DLQ entry max retries reached | id: ${entry.id} | provider: ${entry.provider} | error: ${entry.error_message}`,
            { level: 'warning' },
          )
        }

        dlqFailed++
        console.error(JSON.stringify({
          level: 'error',
          function_name: 'self-monitor',
          message: 'DLQ replay failed',
          dlq_entry_id: entry.id,
          provider: entry.provider,
          retry_count: newCount,
          error: replayErr instanceof Error ? replayErr.message : String(replayErr),
        }))
      }
    }

    if (dlqReplayed > 0 || dlqFailed > 0) {
      actions.push(`DLQ replay: ${dlqReplayed} replayed, ${dlqFailed} failed/exhausted`)
    }
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'self-monitor',
      message: 'Failed to run DLQ replay phase',
      error: err instanceof Error ? err.message : String(err),
    }))
  }

  // 9. HubSpot Stale Check with anti-flood Slack alert (max 1 alert per 24h)
  try {
    const { data: hubspotSync } = await supabase
      .from('data_syncs')
      .select('completed_at')
      .eq('sync_source', 'hubspot')
      .eq('sync_status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const lastHubspotSyncAt = hubspotSync?.completed_at ? new Date(hubspotSync.completed_at) : null
    const { stale, hoursAgo } = computeHubspotStaleness(lastHubspotSyncAt, new Date())

    if (stale) {
      // Anti-flood: try to acquire a 24h lock before alerting
      const lockAcquired = await acquireCronLock(supabase, 'hubspot_stale_alert', 24 * 60 * 60)
      if (lockAcquired) {
        const message = hoursAgo === null
          ? '⚠️ HubSpot jamais synchronisé — vérifier la configuration dans Intégrations'
          : `⚠️ HubSpot sync stale: dernière sync réussie il y a ${Math.round(hoursAgo)}h — vérifier sync-hubspot`
        await alertSlack(message)
        actions.push(`HubSpot stale alert sent (${hoursAgo === null ? 'never synced' : `${Math.round(hoursAgo)}h ago`})`)
      }
    }
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'self-monitor',
      message: 'Failed to check HubSpot staleness',
      error: err instanceof Error ? err.message : String(err),
    }))
  }

  } finally {
    try {
      await releaseCronLock(supabase, 'self-monitor')
    } catch (lockErr) {
      console.error(JSON.stringify({
        level: 'error',
        function_name: 'self-monitor',
        message: `Failed to release cron lock: ${lockErr instanceof Error ? lockErr.message : String(lockErr)}`,
      }))
    }
  }

  return jsonResponse({
    success: true,
    actions_taken: actions.length,
    actions,
    timestamp: new Date().toISOString(),
  })
})
