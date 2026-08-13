// ============================================================
// Edge Function : playbook-execute
// Exécute un playbook sur des comptes spécifiques ou un segment
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError, assertTrialActive } from '../_shared/auth.ts'
import { createLogger } from '../_shared/structured-logger.ts'
import { alertSlack } from '../_shared/slack-alert.ts'
import {
  calculateStepDueDate,
  type PlaybookAction,
  type WorkflowStep,
  type AccountData,
  type ActionResult,
} from '../_shared/playbook-engine.ts'
import { executeWorkflowStep } from '../_shared/workflow-executor.ts'
import { dispatchAction } from '../_shared/action-dispatcher.ts'
import { getBatchCompanyContacts } from '../_shared/hubspot-client.ts'
import { resolveHubSpotApiKey } from '../_shared/vault.ts'
import { resolvePlaybookTargetAccounts } from '../_shared/playbook-targeting.ts'
import { calculateAttributionDeadline, deriveAttributionStatus } from '../_shared/playbook-engine.ts'

const MAX_ACCOUNTS_PER_RUN = 200
const UNMARK_WINDOW_MS = 5 * 60 * 1000
const VALID_NUDGE_RESPONSES = ['resolved', 'not_resolved', 'unsure'] as const

interface ExecutePayload {
  playbook_id: string
  organization_id: string
  account_ids?: string[]
  segment_id?: string
  execution_source?: string
  cooldown_hours?: number
}

// ── Entrypoint ──────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  // ── Sous-routes exécution (chantier C — Playbook Outcome Tracking) ──
  // POST /playbook-execute/{execution_id}/mark-executed | unmark-executed | nudge-response
  // GET  /playbook-execute/{execution_id}/attribution-status
  // Distinctes du corps POST /playbook-execute (déclenchement d'actions
  // automatisées) ci-dessous — cf. API_CONTRACTS.md § 8.1.
  const url = new URL(req.url)
  const segments = url.pathname.split('/').filter(Boolean)
  const fnIndex = segments.indexOf('playbook-execute')
  const subPath = fnIndex >= 0 ? segments.slice(fnIndex + 1) : []

  if (subPath.length === 2) {
    const [executionId, action] = subPath

    let auth
    try {
      auth = await verifyUserAuth(req)
    } catch (err) {
      if (err instanceof AuthError) return errorResponse(err.message, err.status)
      return errorResponse('Authentication failed', 401)
    }

    let supabase: SupabaseClient
    try {
      supabase = createServiceClient()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(JSON.stringify({ level: 'error', function_name: 'playbook-execute', message: msg }))
      return errorResponse('Server configuration error', 500)
    }

    switch (action) {
      case 'mark-executed':
        if (req.method !== 'POST') return errorResponse('Method not allowed', 405)
        return handleMarkExecuted(supabase, executionId, auth.organizationId)
      case 'unmark-executed':
        if (req.method !== 'POST') return errorResponse('Method not allowed', 405)
        return handleUnmarkExecuted(supabase, executionId, auth.organizationId)
      case 'attribution-status':
        if (req.method !== 'GET') return errorResponse('Method not allowed', 405)
        return handleAttributionStatus(supabase, executionId, auth.organizationId)
      case 'nudge-response':
        if (req.method !== 'POST') return errorResponse('Method not allowed', 405)
        return handleNudgeResponse(supabase, executionId, req, auth.organizationId)
      default:
        return errorResponse('Not found', 404)
    }
  }

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  // Détecter si l'appel vient du trigger interne (pg_net depuis PostgreSQL)
  // On utilise PLAYBOOK_TRIGGER_SECRET (dédié) plutôt que SUPABASE_SERVICE_ROLE_KEY
  // pour éviter l'ambiguïté entre la valeur auto-injectée et les secrets custom.
  const incomingToken = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
  const triggerSecret = Deno.env.get('PLAYBOOK_TRIGGER_SECRET') ?? ''
  const isInternalTrigger = triggerSecret !== '' && incomingToken === triggerSecret

  let supabase: SupabaseClient
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-execute', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  let body: ExecutePayload
  try {
    body = await req.json() as ExecutePayload
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (isInternalTrigger) {
    // Appel depuis le trigger DB — organization_id vient du body (déjà scopé par le trigger)
    if (!body.organization_id) {
      return errorResponse('organization_id required for internal trigger calls', 400)
    }
  } else {
    // Appel utilisateur — vérifier le JWT et enforcer l'org depuis le profil
    let auth
    try {
      auth = await verifyUserAuth(req)
    } catch (err) {
      if (err instanceof AuthError) return errorResponse(err.message, err.status)
      return errorResponse('Authentication failed', 401)
    }
    body.organization_id = auth.organizationId

    // Trial gate — utilisateur réel uniquement. Le chemin isInternalTrigger
    // (cron/DB trigger) n'est jamais gaté : c'est une automatisation déjà
    // déclenchée, pas un utilisateur qui se heurte au mur en direct — la
    // bloquer produirait un échec silencieux plutôt qu'un signal clair.
    try {
      await assertTrialActive(supabase, auth.organizationId)
    } catch (err) {
      if (err instanceof AuthError) return errorResponse(err.message, err.status)
      throw err
    }
  }

  const correlationId = crypto.randomUUID()
  const logger = createLogger({
    correlation_id: correlationId,
    function_name: 'playbook-execute',
    organization_id: body.organization_id,
  })

  // ── Validate payload ────────────────────────────────────

  if (!body.playbook_id || !body.organization_id) {
    return errorResponse('playbook_id and organization_id are required', 400)
  }
  if (!body.account_ids?.length && !body.segment_id) {
    return errorResponse('account_ids or segment_id is required', 400)
  }

  // ── Fetch playbook ──────────────────────────────────────

  const { data: playbook, error: pbError } = await supabase
    .from('playbooks')
    .select('*')
    .eq('id', body.playbook_id)
    .eq('organization_id', body.organization_id)
    .single()

  if (pbError || !playbook) return errorResponse('Playbook not found', 404)
  if (playbook.status !== 'active' && playbook.status !== 'draft') {
    return errorResponse('Playbook must be active or draft to execute', 400)
  }

  logger.info('Playbook execution started', { playbook_id: body.playbook_id, playbook_title: playbook.title })

  // ── Resolve target accounts (shared with export-playbook-csv) ──

  const eligibleAccounts = await resolvePlaybookTargetAccounts(
    supabase,
    playbook,
    body.organization_id,
    MAX_ACCOUNTS_PER_RUN,
    body.account_ids,
  )

  if (eligibleAccounts.length === 0) {
    logger.info('No target accounts found')
    return jsonResponse({ success: true, message: 'No eligible accounts', executions_created: 0 })
  }

  // ── Idempotency check ───────────────────────────────────

  const cooldownHours = body.cooldown_hours ?? 24
  const cooldownCutoff = new Date(Date.now() - cooldownHours * 3600000).toISOString()

  const { data: recentExecutions } = await supabase
    .from('playbook_executions')
    .select('account_id')
    .eq('playbook_id', body.playbook_id)
    .gte('executed_at', cooldownCutoff)
    .in('execution_status', ['completed', 'running', 'pending'])

  const recentAccountIds = new Set(
    (recentExecutions ?? []).map((e: Record<string, unknown>) => e.account_id as string),
  )
  const finalAccounts = eligibleAccounts.filter(
    (a: Record<string, unknown>) => !recentAccountIds.has(a.id as string),
  )

  if (finalAccounts.length === 0) {
    logger.info('All eligible accounts have recent executions')
    return jsonResponse({
      success: true,
      message: 'All eligible accounts have recent executions',
      executions_created: 0,
    })
  }

  // ── Execute ─────────────────────────────────────────────

  const isWorkflow = playbook.is_workflow === true
  const actions = (playbook.actions as PlaybookAction[]).sort((a, b) => a.order - b.order)
  const steps = isWorkflow ? (playbook.steps as WorkflowStep[] || []).sort((a, b) => a.step_order - b.step_order) : []
  const totalSteps = isWorkflow ? steps.length : actions.length
  const executionSource = body.execution_source ?? 'manual'
  const executionResults: Array<{
    execution_id: string
    account_id: string
    status: string
    steps: number
    completed: number
    failed: number
  }> = []

  // Resolve CSM email for workflows (org default or first profile)
  let csmEmail = ''
  let csmName = ''
  let orgName = ''
  if (isWorkflow) {
    const { data: orgData } = await supabase
      .from('organizations')
      .select('name')
      .eq('id', body.organization_id)
      .single()
    orgName = orgData?.name || ''

    const { data: profiles } = await supabase
      .from('profiles_')
      .select('email, full_name')
      .eq('organization_id', body.organization_id)
      .limit(1)
    if (profiles && profiles.length > 0) {
      csmEmail = profiles[0].email || ''
      csmName = profiles[0].full_name || ''
    }
  }

  // Résoudre le nom du segment pour l'interpolation dans les actions HubSpot
  let segmentName: string | undefined
  if (body.segment_id) {
    const { data: seg } = await supabase
      .from('account_segments')
      .select('segment_name')
      .eq('id', body.segment_id)
      .maybeSingle()
    segmentName = seg?.segment_name ?? undefined
  }

  // Résoudre la clé HubSpot depuis Vault (nécessaire pour enrollment et update company)
  let hubspotApiKey: string | null = null
  const needsHubspot = !isWorkflow && actions.some(
    (a) => a.type === 'hubspot_enroll_sequence' || a.type === 'hubspot_update_company' || a.type === 'hubspot_create_task',
  )
  if (needsHubspot) {
    hubspotApiKey = await resolveHubSpotApiKey(supabase, body.organization_id)
    if (!hubspotApiKey) {
      logger.warn('HubSpot API key not found — hubspot actions will fail', { organization_id: body.organization_id })
    }
  }

  // Pre-fetch contacts HubSpot en batch pour éviter N+1 (uniquement si des actions le nécessitent)
  let hubspotContactsCache: Map<string, string[]> = new Map()
  if (!isWorkflow && actions.some((a) => a.type === 'hubspot_enroll_sequence')) {
    const companyIds = (finalAccounts as AccountData[])
      .map((a) => a.hubspot_company_id)
      .filter((id): id is string => !!id)
    if (companyIds.length > 0) {
      hubspotContactsCache = await getBatchCompanyContacts(companyIds, hubspotApiKey ?? undefined)
    }
  }

  // Récupérer l'email de notification de l'organisation (requis pour l'action send_email)
  const { data: orgNotifData } = await supabase
    .from('organizations')
    .select('notification_email')
    .eq('id', body.organization_id)
    .maybeSingle()

  const organizationNotificationEmail: string | null = orgNotifData?.notification_email ?? null
  if (!organizationNotificationEmail) {
    logger.warn('notification_email non configuré pour cette organisation', { organization_id: body.organization_id })
  }

  // Traitement d'un compte — retourne le résultat ou null si le compte est ignoré
  const processAccount = async (account: Record<string, unknown>): Promise<typeof executionResults[number] | null> => {
    const acc = account as AccountData
    let executionId: string | null = null

    try {
      if (isWorkflow) {
        // ── Workflow execution: run step 1 now, schedule remaining steps ──
        const firstStep = steps[0]
        if (!firstStep) {
          logger.error('Workflow has no steps', { account_id: acc.id })
          return null
        }

        const nextStep = steps.length > 1 ? steps[1] : null
        const nextStepDueAt = nextStep ? calculateStepDueDate(nextStep.delay_days) : null

        const { data: execution, error: execError } = await supabase
          .from('playbook_executions')
          .insert({
            organization_id: body.organization_id,
            playbook_id: body.playbook_id,
            account_id: acc.id,
            segment_id: body.segment_id ?? playbook.segment_id ?? null,
            execution_status: 'running',
            execution_source: executionSource,
            total_steps: totalSteps,
            completed_steps: 0,
            failed_steps: 0,
            health_score_before: acc.health_score,
            churn_risk_before: acc.churn_risk_score,
            started_at: new Date().toISOString(),
            current_step: 1,
            next_step_due_at: nextStepDueAt,
            workflow_completed: steps.length <= 1,
          })
          .select('id')
          .single()

        if (execError || !execution) {
          logger.error('Failed to create workflow execution', { account_id: acc.id, error: execError?.message })
          return null
        }

        executionId = execution.id

        const stepResult = await executeWorkflowStep(firstStep, acc, {
          playbookId: body.playbook_id,
          executionId: execution.id,
          csmEmail: csmEmail,
          csmName: csmName,
          orgName: orgName,
        })

        const isCompleted = stepResult.status === 'completed'
        const workflowDone = steps.length <= 1

        const updatePayload: Record<string, unknown> = {
          completed_steps: isCompleted ? 1 : 0,
          failed_steps: isCompleted ? 0 : 1,
          actions_completed: [stepResult],
          steps_timeline: [stepResult],
        }

        if (stepResult.action_type === 'send_email' && isCompleted) {
          updatePayload.emails_sent = 1
          updatePayload.last_email_sent_at = new Date().toISOString()
        }

        if (workflowDone) {
          updatePayload.execution_status = isCompleted ? 'completed' : 'failed'
          updatePayload.workflow_completed = true
          updatePayload.completed_at = new Date().toISOString()
        }

        await supabase.from('playbook_executions').update(updatePayload).eq('id', execution.id)

        return {
          execution_id: execution.id,
          account_id: acc.id,
          status: workflowDone ? (isCompleted ? 'completed' : 'failed') : 'running',
          steps: totalSteps,
          completed: isCompleted ? 1 : 0,
          failed: isCompleted ? 0 : 1,
        }
      } else {
        // ── Standard playbook execution ──
        const { data: execution, error: execError } = await supabase
          .from('playbook_executions')
          .insert({
            organization_id: body.organization_id,
            playbook_id: body.playbook_id,
            account_id: acc.id,
            segment_id: body.segment_id ?? playbook.segment_id ?? null,
            execution_status: 'running',
            execution_source: executionSource,
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
          logger.error('Failed to create execution record', { account_id: acc.id, error: execError?.message })
          return null
        }

        executionId = execution.id

        const actionResults: ActionResult[] = []
        let completedSteps = 0
        let failedSteps = 0

        for (const action of actions) {
          const result = await dispatchAction(action, acc, {
            playbookId: body.playbook_id,
            executionId: execution.id,
            organizationId: body.organization_id,
            playbookTitle: playbook.title,
            segmentName,
            organization_notification_email: organizationNotificationEmail ?? undefined,
            accounts_targeted: finalAccounts.length,
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

        const { error: updateError } = await supabase
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

        if (updateError) {
          logger.error('Failed to update execution record', { execution_id: execution.id, error: updateError.message })
        }

        return {
          execution_id: execution.id,
          account_id: acc.id,
          status: finalStatus,
          steps: actions.length,
          completed: completedSteps,
          failed: failedSteps,
        }
      }
    } catch (err) {
      if (executionId) {
        await supabase
          .from('playbook_executions')
          .update({ execution_status: 'failed', completed_at: new Date().toISOString() })
          .eq('id', executionId)
      }
      logger.error('Execution failed for account', {
        account_id: acc.id,
        execution_id: executionId,
        error: err instanceof Error ? err.message : String(err),
      })
      return {
        execution_id: executionId ?? 'unknown',
        account_id: acc.id,
        status: 'failed',
        steps: totalSteps,
        completed: 0,
        failed: totalSteps,
      }
    }
  }

  // Exécution en chunks parallèles (5 comptes simultanés)
  const ACCOUNT_CONCURRENCY = 5
  for (let i = 0; i < finalAccounts.length; i += ACCOUNT_CONCURRENCY) {
    const chunk = finalAccounts.slice(i, i + ACCOUNT_CONCURRENCY)
    const chunkResults = await Promise.allSettled(chunk.map(processAccount))
    for (const r of chunkResults) {
      if (r.status === 'fulfilled' && r.value !== null) {
        executionResults.push(r.value)
      }
    }
  }

  // ── Update playbook KPIs (atomic pour éviter TOCTOU) ───────

  const accountsTargeted = finalAccounts.length
  const accountsReached = executionResults.filter((r) => r.status !== 'failed').length

  const { error: kpiError } = await supabase.rpc('increment_playbook_kpis', {
    p_playbook_id: body.playbook_id,
    p_accounts_eligible: eligibleAccounts.length,
    p_accounts_targeted: accountsTargeted,
    p_accounts_reached: accountsReached,
  })

  if (kpiError) {
    logger.error('Failed to update playbook KPIs', { error: kpiError.message })
  }

  // ── Slack alert on failures ─────────────────────────────

  const failedCount = executionResults.filter((r) => r.status === 'failed').length
  if (failedCount > 0) {
    await alertSlack(
      `Playbook "${playbook.title}" : ${failedCount}/${executionResults.length} exécutions échouées`,
      { level: 'warning' },
    )
  }

  logger.info('Playbook execution completed', {
    executions_created: executionResults.length,
    failed: failedCount,
  })

  const hasMore = body.account_ids
    ? body.account_ids.length > MAX_ACCOUNTS_PER_RUN
    : eligibleAccounts.length >= MAX_ACCOUNTS_PER_RUN

  return jsonResponse({
    success: true,
    playbook_id: body.playbook_id,
    executions_created: executionResults.length,
    has_more: hasMore,
    results: executionResults,
  })
})

// ============================================================
// Playbook Outcome Tracking (chantier C) — sous-routes exécution
// cf. API_CONTRACTS.md § 8.1 / § 8.1.1 / § 8.2 / § 8.4
// ============================================================

// ── mark-executed (§8.1) ─────────────────────────────────────

export async function handleMarkExecuted(
  supabase: SupabaseClient,
  executionId: string,
  authOrgId: string,
): Promise<Response> {
  const { data: execution, error } = await supabase
    .from('playbook_executions')
    .select('id, playbook_id, manual_executed_at, attribution_deadline_at')
    .eq('id', executionId)
    .eq('organization_id', authOrgId)
    .maybeSingle()

  if (error || !execution) return errorResponse('Execution not found', 404)

  if (execution.manual_executed_at) {
    return jsonResponse({
      execution_id: execution.id,
      executed_at: execution.manual_executed_at,
      attribution_deadline_at: execution.attribution_deadline_at,
    })
  }

  const { data: playbook } = await supabase
    .from('playbooks')
    .select('attribution_window_days')
    .eq('id', execution.playbook_id)
    .maybeSingle()

  const now = new Date()
  const deadline = calculateAttributionDeadline(now, playbook?.attribution_window_days ?? null)

  const { data: updated, error: updateError } = await supabase
    .from('playbook_executions')
    .update({ manual_executed_at: now.toISOString(), attribution_deadline_at: deadline })
    .eq('id', executionId)
    .eq('organization_id', authOrgId)
    .select('id, manual_executed_at, attribution_deadline_at')
    .single()

  if (updateError || !updated) {
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-execute', op: 'mark-executed', message: updateError?.message }))
    return errorResponse('Failed to mark execution as executed', 500)
  }

  return jsonResponse({
    execution_id: updated.id,
    executed_at: updated.manual_executed_at,
    attribution_deadline_at: updated.attribution_deadline_at,
  })
}

// ── unmark-executed (§8.1.1) ──────────────────────────────────

export async function handleUnmarkExecuted(
  supabase: SupabaseClient,
  executionId: string,
  authOrgId: string,
): Promise<Response> {
  const { data: execution, error } = await supabase
    .from('playbook_executions')
    .select('id, manual_executed_at, account_converted, resolved_via, nudge_response')
    .eq('id', executionId)
    .eq('organization_id', authOrgId)
    .maybeSingle()

  if (error || !execution) return errorResponse('Execution not found', 404)

  if (!execution.manual_executed_at) {
    return jsonResponse({ execution_id: execution.id, executed_at: null, attribution_deadline_at: null })
  }

  // Conflits — priment sur l'expiration de la fenêtre de 5 min (cf. API_CONTRACTS.md § 8.1.1)
  if (execution.account_converted === true || execution.resolved_via) {
    return errorResponse('Cannot unmark an execution with an automatically detected resolution', 409)
  }
  if (execution.nudge_response) {
    return errorResponse('Cannot unmark an execution with a recorded nudge response', 409)
  }

  const markedAtMs = new Date(execution.manual_executed_at).getTime()
  if (Date.now() - markedAtMs > UNMARK_WINDOW_MS) {
    return errorResponse('Unmark window (5 minutes) has expired', 409)
  }

  const { data: updated, error: updateError } = await supabase
    .from('playbook_executions')
    .update({ manual_executed_at: null, attribution_deadline_at: null })
    .eq('id', executionId)
    .eq('organization_id', authOrgId)
    .select('id')
    .single()

  if (updateError || !updated) {
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-execute', op: 'unmark-executed', message: updateError?.message }))
    return errorResponse('Failed to unmark execution', 500)
  }

  return jsonResponse({ execution_id: updated.id, executed_at: null, attribution_deadline_at: null })
}

// ── attribution-status (§8.2) ─────────────────────────────────

export async function handleAttributionStatus(
  supabase: SupabaseClient,
  executionId: string,
  authOrgId: string,
): Promise<Response> {
  const { data: execution, error } = await supabase
    .from('playbook_executions')
    .select('id, manual_executed_at, attribution_deadline_at, account_converted')
    .eq('id', executionId)
    .eq('organization_id', authOrgId)
    .maybeSingle()

  if (error || !execution) return errorResponse('Execution not found', 404)

  const now = new Date()
  const status = deriveAttributionStatus(
    {
      marked_executed_at: execution.manual_executed_at,
      account_converted: execution.account_converted,
      attribution_deadline_at: execution.attribution_deadline_at,
    },
    now,
  )

  let timeRemainingSeconds: number | null
  if (status === 'not_executed') {
    timeRemainingSeconds = null
  } else if (status === 'active') {
    timeRemainingSeconds = Math.max(
      0,
      Math.floor((new Date(execution.attribution_deadline_at as string).getTime() - now.getTime()) / 1000),
    )
  } else {
    timeRemainingSeconds = 0
  }

  return jsonResponse({
    execution_id: execution.id,
    executed_at: execution.manual_executed_at,
    attribution_deadline_at: execution.attribution_deadline_at,
    attribution_status: status,
    time_remaining_seconds: timeRemainingSeconds,
  })
}

// ── nudge-response (§8.4) ──────────────────────────────────────

export async function handleNudgeResponse(
  supabase: SupabaseClient,
  executionId: string,
  req: Request,
  authOrgId: string,
): Promise<Response> {
  let body: { response?: string }
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!body.response || !(VALID_NUDGE_RESPONSES as readonly string[]).includes(body.response)) {
    return errorResponse(`response must be one of: ${VALID_NUDGE_RESPONSES.join(', ')}`, 400)
  }

  const { data: execution, error } = await supabase
    .from('playbook_executions')
    .select('id, manual_executed_at')
    .eq('id', executionId)
    .eq('organization_id', authOrgId)
    .maybeSingle()

  if (error || !execution) return errorResponse('Execution not found', 404)

  if (!execution.manual_executed_at) {
    return errorResponse('Execution is not marked as executed yet', 409)
  }

  const nowIso = new Date().toISOString()
  const { data: updated, error: updateError } = await supabase
    .from('playbook_executions')
    .update({ nudge_response: body.response, nudge_responded_at: nowIso })
    .eq('id', executionId)
    .eq('organization_id', authOrgId)
    .select('id, nudge_response, nudge_responded_at')
    .single()

  if (updateError || !updated) {
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-execute', op: 'nudge-response', message: updateError?.message }))
    return errorResponse('Failed to record nudge response', 500)
  }

  return jsonResponse({
    execution_id: updated.id,
    nudge_response: updated.nudge_response,
    nudge_responded_at: updated.nudge_responded_at,
  })
}
