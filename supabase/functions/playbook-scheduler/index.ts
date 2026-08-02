// ============================================================
// Edge Function : playbook-scheduler
// Cron : exécution automatique des playbooks planifiés
// Pattern : acquireCronLock → DataSyncLogger → alertSlack → releaseCronLock
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { acquireCronLock, releaseCronLock } from '../_shared/cron-lock.ts'
import { DataSyncLogger } from '../_shared/data-sync-logger.ts'
import { alertSlack } from '../_shared/slack-alert.ts'
import { createLogger } from '../_shared/structured-logger.ts'
import {
  evaluateConditions,
  calculateNextScheduledAt,
  type PlaybookAction,
  type AccountData,
  type ActionResult,
  type ExecutionFrequency,
  VALID_EXECUTION_FREQUENCIES,
} from '../_shared/playbook-engine.ts'
import { dispatchAction } from '../_shared/action-dispatcher.ts'
import { getBatchCompanyContacts } from '../_shared/hubspot-client.ts'
import { resolveHubSpotApiKey } from '../_shared/vault.ts'

const MAX_ACCOUNTS_PER_PLAYBOOK = 200
const COOLDOWN_HOURS = 24
const LOCK_KEY = 'playbook-scheduler'
const LOCK_TTL_SECONDS = 300

// ── Entrypoint ──────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  let supabase: SupabaseClient
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: LOCK_KEY, message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const correlationId = crypto.randomUUID()
  const logger = createLogger({
    correlation_id: correlationId,
    function_name: LOCK_KEY,
  })

  // ── Acquire cron lock ───────────────────────────────────

  const lockAcquired = await acquireCronLock(supabase, LOCK_KEY, LOCK_TTL_SECONDS)
  if (!lockAcquired) {
    logger.warn('Scheduler already running, skipping')
    return errorResponse('Scheduler already running', 409)
  }

  const results: Array<{
    playbook_id: string
    organization_id: string
    accounts_executed: number
    errors: number
  }> = []

  try {
    // ── Find due automated playbooks ──────────────────────

    const now = new Date().toISOString()
    const { data: duePlaybooks, error: pbError } = await supabase
      .from('playbooks')
      .select('*')
      .eq('is_automated', true)
      .eq('status', 'active')
      .lte('next_scheduled_at', now)
      .order('next_scheduled_at', { ascending: true })
      .limit(50)

    if (pbError) {
      logger.error('Failed to query due playbooks', { error: pbError.message })
      await alertSlack(`playbook-scheduler: query failed: ${pbError.message}`, { level: 'critical' })
      return errorResponse(`Query failed: ${pbError.message}`, 500)
    }

    if (!duePlaybooks?.length) {
      logger.info('No playbooks due for execution')
      return jsonResponse({ success: true, message: 'No playbooks due', processed: 0 })
    }

    logger.info(`Found ${duePlaybooks.length} playbook(s) due for execution`)

    // ── Process each playbook ─────────────────────────────

    for (const playbook of duePlaybooks) {
      const orgId = playbook.organization_id as string
      const playbookId = playbook.id as string

      const syncLogger = new DataSyncLogger({
        supabase,
        organizationId: orgId,
        syncSource: 'manual',
        syncType: 'daily',
        triggeredBy: 'cron',
      })
      await syncLogger.start()

      let accountsExecuted = 0
      let errors = 0

      try {
        // ── Resolve eligible accounts ─────────────────────

        let accountQuery = supabase
          .from('accounts')
          .select('id, organization_id, stripe_customer_id, hubspot_company_id, display_name, health_score, churn_risk_score, expansion_score, product_usage_score, mrr_cents, arr_cents, plan_tier, seat_count, seat_limit, contract_start_date, contract_end_date, created_at')
          .eq('organization_id', orgId)

        // Filter by segment if defined
        if (playbook.segment_id) {
          const { data: membershipIds } = await supabase
            .from('segment_memberships')
            .select('account_id')
            .eq('segment_id', playbook.segment_id)
            .eq('status', 'active')
            .limit(MAX_ACCOUNTS_PER_PLAYBOOK)

          const ids = (membershipIds ?? []).map((m: Record<string, unknown>) => m.account_id as string)
          if (ids.length === 0) {
            logger.info('No accounts in segment, skipping playbook', { playbook_id: playbookId })
            await updateNextSchedule(supabase, playbook)
            await syncLogger.complete({ playbook_id: playbookId, accounts_executed: 0 })
            results.push({ playbook_id: playbookId, organization_id: orgId, accounts_executed: 0, errors: 0 })
            continue
          }
          accountQuery = accountQuery.in('id', ids)
        } else {
          accountQuery = accountQuery.limit(MAX_ACCOUNTS_PER_PLAYBOOK)
        }

        const { data: accounts } = await accountQuery

        if (!accounts?.length) {
          logger.info('No accounts found for org', { playbook_id: playbookId })
          await updateNextSchedule(supabase, playbook)
          await syncLogger.complete({ playbook_id: playbookId, accounts_executed: 0 })
          results.push({ playbook_id: playbookId, organization_id: orgId, accounts_executed: 0, errors: 0 })
          continue
        }

        // ── Filter by eligibility criteria ────────────────
        // C2.5 : plus de bypass sur eligibility_criteria vide/absent — avant
        // ce chantier, un playbook sans segment_id NI eligibility_criteria
        // s'exécutait sur la totalité des comptes de l'org (accountQuery
        // ci-dessus ne pose alors aucune limite autre que
        // MAX_ACCOUNTS_PER_PLAYBOOK). evaluateConditions ne matche plus rien
        // par défaut sans conditions explicites ou match_all:true (voir
        // playbook-engine.ts) — migration de backfill sur les playbooks
        // existants pour préserver leur comportement actuel.

        const eligible = accounts.filter((a: Record<string, unknown>) => evaluateConditions(playbook.eligibility_criteria, a))

        // ── Idempotency check ─────────────────────────────

        const cooldownCutoff = new Date(Date.now() - COOLDOWN_HOURS * 3600000).toISOString()
        const { data: recent } = await supabase
          .from('playbook_executions')
          .select('account_id')
          .eq('playbook_id', playbookId)
          .gte('executed_at', cooldownCutoff)
          .in('execution_status', ['completed', 'running', 'pending'])

        const recentSet = new Set(
          (recent ?? []).map((r: Record<string, unknown>) => r.account_id as string),
        )
        const finalAccounts = eligible.filter(
          (a: Record<string, unknown>) => !recentSet.has(a.id as string),
        )

        if (finalAccounts.length === 0) {
          logger.info('All accounts have recent executions', { playbook_id: playbookId })
          await updateNextSchedule(supabase, playbook)
          await syncLogger.complete({ playbook_id: playbookId, accounts_executed: 0 })
          results.push({ playbook_id: playbookId, organization_id: orgId, accounts_executed: 0, errors: 0 })
          continue
        }

        // ── Execute for each account ──────────────────────

        const actions = (playbook.actions as PlaybookAction[]).sort((a, b) => a.order - b.order)

        // Résoudre le nom du segment pour l'interpolation dans les actions HubSpot
        let segmentName: string | undefined
        if (playbook.segment_id) {
          const { data: seg } = await supabase
            .from('account_segments')
            .select('segment_name')
            .eq('id', playbook.segment_id)
            .maybeSingle()
          segmentName = seg?.segment_name ?? undefined
        }

        // Résoudre la clé HubSpot depuis Vault
        let hubspotApiKey: string | null = null
        const needsHubspot = actions.some(
          (a) => a.type === 'hubspot_enroll_sequence' || a.type === 'hubspot_update_company' || a.type === 'hubspot_create_task',
        )
        if (needsHubspot) {
          hubspotApiKey = await resolveHubSpotApiKey(supabase, orgId)
          if (!hubspotApiKey) {
            logger.warn('HubSpot API key not found — hubspot actions will fail', { organization_id: orgId })
          }
        }

        // Pre-fetch contacts HubSpot en batch pour éviter N+1
        let hubspotContactsCache: Map<string, string[]> = new Map()
        if (actions.some((a) => a.type === 'hubspot_enroll_sequence')) {
          const companyIds = (finalAccounts as AccountData[])
            .map((a) => a.hubspot_company_id)
            .filter((id): id is string => !!id)
          if (companyIds.length > 0) {
            hubspotContactsCache = await getBatchCompanyContacts(companyIds, hubspotApiKey ?? undefined)
          }
        }

        // Traitement d'un compte — retourne true si completed
        const processAccount = async (account: Record<string, unknown>): Promise<boolean> => {
          const acc = account as AccountData

          const { data: execution, error: execError } = await supabase
            .from('playbook_executions')
            .insert({
              organization_id: orgId,
              playbook_id: playbookId,
              account_id: acc.id,
              segment_id: playbook.segment_id ?? null,
              execution_status: 'running',
              execution_source: 'scheduled',
              total_steps: actions.length,
              completed_steps: 0,
              failed_steps: 0,
              health_score_before: acc.health_score,
              churn_risk_before: acc.churn_risk_score,
              started_at: new Date().toISOString(),
            })
            .select('id')
            .single()

          if (execError || !execution) {
            logger.error('Failed to create execution', { account_id: acc.id, error: execError?.message })
            return false
          }

          const actionResults: ActionResult[] = []
          let completedSteps = 0
          let failedSteps = 0

          for (const action of actions) {
            const result = await dispatchAction(action, acc, {
              playbookId,
              executionId: execution.id,
              organizationId: orgId,
              playbookTitle: playbook.title as string | undefined,
              segmentName,
              contactsCache: hubspotContactsCache,
              hubspotApiKey: hubspotApiKey ?? undefined,
            }, supabase)
            actionResults.push(result)
            if (result.status === 'completed') completedSteps++
            else if (result.status === 'failed') failedSteps++
          }

          let finalStatus: string
          if (failedSteps === 0) finalStatus = 'completed'
          else if (completedSteps === 0) finalStatus = 'failed'
          else finalStatus = 'partially_completed'

          await supabase
            .from('playbook_executions')
            .update({
              execution_status: finalStatus,
              actions_completed: actionResults,
              steps_timeline: actionResults,
              completed_steps: completedSteps,
              failed_steps: failedSteps,
              completed_at: new Date().toISOString(),
            })
            .eq('id', execution.id)

          syncLogger.increment('records_processed')
          return finalStatus === 'completed'
        }

        // Exécution en chunks parallèles (5 comptes simultanés)
        const ACCOUNT_CONCURRENCY = 5
        for (let i = 0; i < finalAccounts.length; i += ACCOUNT_CONCURRENCY) {
          const chunk = finalAccounts.slice(i, i + ACCOUNT_CONCURRENCY)
          const chunkResults = await Promise.allSettled(chunk.map(processAccount))
          for (const r of chunkResults) {
            if (r.status === 'fulfilled' && r.value) accountsExecuted++
            else errors++
          }
        }

        // ── Update playbook KPIs (atomic pour éviter TOCTOU) ─

        await supabase.rpc('increment_playbook_kpis', {
          p_playbook_id: playbookId,
          p_accounts_eligible: eligible.length,
          p_accounts_targeted: finalAccounts.length,
          p_accounts_reached: accountsExecuted,
        })

        await updateNextSchedule(supabase, playbook)
        await syncLogger.complete({
          playbook_id: playbookId,
          accounts_executed: accountsExecuted,
          errors,
        })

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('Playbook execution failed', { playbook_id: playbookId, error: msg })
        await syncLogger.fail(msg)
        errors++
        await alertSlack(
          `playbook-scheduler: playbook ${playbookId} failed: ${msg}`,
          { level: 'warning' },
        )
      }

      results.push({
        playbook_id: playbookId,
        organization_id: orgId,
        accounts_executed: accountsExecuted,
        errors,
      })
    }

    const totalErrors = results.reduce((sum, r) => sum + r.errors, 0)
    if (totalErrors > 0) {
      await alertSlack(
        `playbook-scheduler terminé: ${results.length} playbooks, ${totalErrors} erreur(s)`,
        { level: 'warning' },
      )
    }

    logger.info('Scheduler run completed', {
      processed: results.length,
      total_errors: totalErrors,
    })

    return jsonResponse({ success: true, processed: results.length, results })

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('Scheduler global failure', { error: msg })
    await alertSlack(`playbook-scheduler: global failure: ${msg}`, { level: 'critical' })
    return errorResponse(`Scheduler failed: ${msg}`, 500)
  } finally {
    try {
      await releaseCronLock(supabase, LOCK_KEY)
    } catch (lockErr) {
      console.error(JSON.stringify({
        level: 'error',
        function_name: LOCK_KEY,
        message: `Failed to release cron lock: ${lockErr instanceof Error ? lockErr.message : String(lockErr)}`,
      }))
    }
  }
})

// ── Helper ──────────────────────────────────────────────────

async function updateNextSchedule(
  supabase: SupabaseClient,
  playbook: Record<string, unknown>,
): Promise<void> {
  const frequency = playbook.execution_frequency as string | null
  if (frequency && (VALID_EXECUTION_FREQUENCIES as readonly string[]).includes(frequency)) {
    const { error } = await supabase
      .from('playbooks')
      .update({
        next_scheduled_at: calculateNextScheduledAt(frequency as ExecutionFrequency),
      })
      .eq('id', playbook.id)

    if (error) {
      console.error(`[playbook-scheduler] Failed to update next_scheduled_at for playbook ${playbook.id}: ${error.message}`)
    }
  }
}
