// ============================================================
// Edge Function : playbook-execute
// Exécute un playbook sur des comptes spécifiques ou un segment
// ============================================================
//
// POST /functions/v1/playbook-execute
// Authorization: Bearer <supabase_jwt>
//
// Body: {
//   playbook_id: string,
//   account_ids?: string[],      // explicit list OR
//   segment?: string             // target by segment
// }
//
// Réponse succès (200):
// For automated/manual: { execution_id: string, status: "running" | "completed", accounts_count: number }
// For semi_automated:  { execution_id: string, status: "pending_approval", accounts_count: number }
//
// Réponses erreur:
// 400 { error: string }  — playbook_id manquant, paramètres invalides
// 403 { error: string }  — org mismatch
// 404 { error: string }  — playbook introuvable
// 500 { error: string }  — erreur serveur
//
// Champs exposés au frontend: execution_id, status, accounts_count
// Champs internes uniquement: execution_log, triggered_at details
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { createLogger } from '../_shared/structured-logger.ts'
import { alertSlack } from '../_shared/slack-alert.ts'
import {
  evaluateConditions,
  executeAction,
  calculateStepDueDate,
  type PlaybookAction,
  type WorkflowStep,
  type AccountData,
  type ActionResult,
} from '../_shared/playbook-engine.ts'
import { executeWorkflowStep } from '../_shared/workflow-executor.ts'
import { dispatchWebhook, mapPlaybookToEvent } from '../_shared/webhook-dispatcher.ts'
import { buildPendingApprovalLog, buildApprovalSlackMessage } from '../_shared/playbook-approval-helpers.ts'
import {
  buildSlackNotifyMessage,
  buildFlagEntry,
  mergeFlag,
  buildNoteEntry,
  type FlagEntry,
} from '../_shared/playbook-actions-helpers.ts'
import { createHubSpotTask, associateTaskToCompany } from '../_shared/hubspot-actions.ts'
import { getVaultSecret } from '../_shared/vault.ts'
import { writeToDLQ } from '../_shared/dlq.ts'

const MAX_ACCOUNTS_PER_RUN = 200

interface ExecutePayload {
  playbook_id: string
  organization_id: string
  account_ids?: string[]
  segment_id?: string
  execution_source?: string
  cooldown_hours?: number
}

// ── HubSpot create_task handler ──────────────────────────────

/**
 * Handles the create_task action by creating a real HubSpot CRM task
 * and associating it to the company. Gracefully degrades when HubSpot
 * is not connected or hubspot_company_id is missing.
 */
async function handleCreateTaskAction(
  supabase: SupabaseClient,
  action: PlaybookAction,
  account: AccountData,
  orgId: string,
  hubspotConnected: boolean,
  hubspotToken: string | null,
  logger: ReturnType<typeof createLogger>,
): Promise<ActionResult> {
  const now = new Date().toISOString()

  // Skip gracefully if HubSpot not connected
  if (!hubspotConnected || !hubspotToken) {
    return {
      action_type: 'create_task',
      order: action.order,
      status: 'skipped',
      message: 'HubSpot not connected — task creation skipped',
      executed_at: now,
    }
  }

  // Look up the hubspot_company_id for this account
  const { data: hubspotLink } = await supabase
    .from('hubspot_companies')
    .select('hubspot_company_id')
    .eq('organization_id', orgId)
    .eq('account_id', account.id)
    .maybeSingle()

  if (!hubspotLink?.hubspot_company_id) {
    return {
      action_type: 'create_task',
      order: action.order,
      status: 'skipped',
      message: `No HubSpot company linked to account ${account.id}`,
      executed_at: now,
    }
  }

  try {
    const taskTitle = (action.config?.title as string) ?? 'Tache Sentio'
    const dueDays = (action.config?.due_days as number) ?? 3

    // Build trigger reason from account scores (Zero-PII)
    const bodyParts: string[] = []
    if (account.churn_risk_score != null) bodyParts.push(`Churn: ${account.churn_risk_score}%`)
    if (account.health_score != null) bodyParts.push(`Sante: ${account.health_score}`)
    if (account.mrr_cents != null) bodyParts.push(`MRR: ${(account.mrr_cents / 100).toFixed(0)} EUR`)
    const taskBody = bodyParts.length > 0
      ? `Compte Sentio a risque | ${bodyParts.join(' | ')}`
      : 'Tache creee par Sentio AI'

    const result = await createHubSpotTask(hubspotToken, {
      title: taskTitle,
      body: taskBody,
      dueDays,
    })

    // Associate task to company (non-critical — catch separately)
    try {
      await associateTaskToCompany(hubspotToken, result.taskId, hubspotLink.hubspot_company_id)
      result.associationSuccess = true
    } catch (assocErr) {
      logger.error('HubSpot task association failed (non-critical)', {
        task_id: result.taskId,
        company_id: hubspotLink.hubspot_company_id,
        error: assocErr instanceof Error ? assocErr.message : String(assocErr),
      })
    }

    return {
      action_type: 'create_task',
      order: action.order,
      status: 'completed',
      message: `HubSpot task created (id: ${result.taskId}, associated: ${result.associationSuccess})`,
      executed_at: now,
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)

    // Write to DLQ for retry — don't fail the entire execution
    await writeToDLQ(supabase, {
      organization_id: orgId,
      provider: 'hubspot',
      event_type: 'hubspot_task_creation_failed',
      payload: {
        account_id: account.id,
        hubspot_company_id: hubspotLink.hubspot_company_id,
        task_title: (action.config?.title as string) ?? 'Tache Sentio',
        task_body: taskBody,
        task_due_days: dueDays,
        error: errorMsg,
      },
      error_message: errorMsg,
    })

    logger.error('HubSpot task creation failed', {
      account_id: account.id,
      error: errorMsg,
    })

    return {
      action_type: 'create_task',
      order: action.order,
      status: 'failed',
      message: `HubSpot task creation failed: ${errorMsg}`,
      executed_at: now,
    }
  }
}

// ── Entrypoint ──────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  // Auth : vérifier le JWT utilisateur (ES256)
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

  let body: ExecutePayload
  try {
    body = await req.json() as ExecutePayload
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  // Always enforce the authenticated user's organization (prevent cross-tenant access)
  body.organization_id = auth.organizationId

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

  // ── Resolve target accounts ─────────────────────────────

  let accountIds: string[]

  if (body.account_ids?.length) {
    accountIds = body.account_ids.slice(0, MAX_ACCOUNTS_PER_RUN)
  } else {
    const { data: memberships } = await supabase
      .from('segment_memberships')
      .select('account_id')
      .eq('segment_id', body.segment_id!)
      .eq('organization_id', body.organization_id)
      .eq('status', 'active')
      .limit(MAX_ACCOUNTS_PER_RUN)

    accountIds = (memberships ?? []).map((m: Record<string, unknown>) => m.account_id as string)
  }

  if (accountIds.length === 0) {
    logger.info('No target accounts found')
    return jsonResponse({ success: true, message: 'No eligible accounts', executions_created: 0 })
  }

  // ── Fetch account data ──────────────────────────────────

  const { data: accounts } = await supabase
    .from('accounts')
    .select('id, organization_id, stripe_customer_id, hubspot_company_id, health_score, churn_risk_score, expansion_score, product_usage_score, mrr_cents, arr_cents, plan_tier, seat_count, seat_limit, contract_start_date, contract_end_date, created_at')
    .eq('organization_id', body.organization_id)
    .in('id', accountIds)

  if (!accounts?.length) {
    return jsonResponse({ success: true, message: 'No accounts found', executions_created: 0 })
  }

  // ── Filter by eligibility criteria ──────────────────────

  const eligibleAccounts = playbook.eligibility_criteria
    ? accounts.filter((a: Record<string, unknown>) =>
        evaluateConditions(playbook.eligibility_criteria, a))
    : accounts

  // ── Idempotency check ───────────────────────────────────

  const cooldownHours = body.cooldown_hours ?? 24
  const cooldownCutoff = new Date(Date.now() - cooldownHours * 3600000).toISOString()

  const { data: recentExecutions } = await supabase
    .from('playbook_executions')
    .select('account_id')
    .eq('playbook_id', body.playbook_id)
    .gte('executed_at', cooldownCutoff)
    .in('execution_status', ['completed', 'running', 'pending', 'pending_approval'])

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

  // ── Semi-automated: create pending_approval, do NOT launch actions ──

  const isSemiAutomated = playbook.playbook_type === 'semi_automated'

  if (isSemiAutomated) {
    const finalAccountIds = finalAccounts.map((a: Record<string, unknown>) => a.id as string)
    const sortedActions = (playbook.actions as PlaybookAction[]).sort((a, b) => a.order - b.order)
    const actionTypes = sortedActions.map((a) => a.type)

    const pendingLog = buildPendingApprovalLog(
      finalAccountIds,
      sortedActions,
    )

    const { data: execution, error: execError } = await supabase
      .from('playbook_executions')
      .insert({
        organization_id: body.organization_id,
        playbook_id: body.playbook_id,
        execution_status: 'pending_approval',
        execution_source: body.execution_source ?? 'manual',
        execution_log: pendingLog,
        accounts_targeted: finalAccounts.length,
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (execError || !execution) {
      logger.error('Failed to create pending_approval execution', { error: execError?.message })
      return errorResponse('Failed to create execution', 500)
    }

    // Slack notification for pending approval (fire-and-forget)
    const frontendUrl = Deno.env.get('FRONTEND_URL') ?? ''
    const slackMsg = buildApprovalSlackMessage(
      playbook.title,
      finalAccounts.length,
      actionTypes,
      frontendUrl,
      body.playbook_id,
      execution.id,
    )
    await alertSlack(slackMsg, { level: 'info' })

    logger.info('Semi-automated execution created, pending approval', {
      execution_id: execution.id,
      accounts_count: finalAccounts.length,
    })

    return jsonResponse({
      execution_id: execution.id,
      status: 'pending_approval',
      accounts_count: finalAccounts.length,
    })
  }

  // ── Execute (automated / manual) ──────────────────────

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

  // ── Pre-resolve HubSpot credentials if any action needs it ──
  const hasCreateTaskAction = actions.some((a) => a.type === 'create_task')
  let hubspotToken: string | null = null
  let hubspotConnected = false

  if (hasCreateTaskAction) {
    const { data: hsIntegration } = await supabase
      .from('organization_integrations')
      .select('vault_access_token_id, provider_account_id, integration_method')
      .eq('organization_id', body.organization_id)
      .eq('provider', 'hubspot')
      .eq('is_active', true)
      .maybeSingle()

    if (hsIntegration?.vault_access_token_id) {
      hubspotToken = await getVaultSecret(supabase, hsIntegration.vault_access_token_id)
      hubspotConnected = hubspotToken !== null
    }

    if (!hubspotConnected) {
      logger.info('HubSpot not connected — create_task actions will be skipped')
    }
  }

  for (const account of finalAccounts) {
    const acc = account as AccountData
    let executionId: string | null = null

    try {
      if (isWorkflow) {
        // ── Workflow execution: run step 1 now, schedule remaining steps ──
        const firstStep = steps[0]
        if (!firstStep) {
          logger.error('Workflow has no steps', { account_id: acc.id })
          continue
        }

        // Calculate next step due date
        const nextStep = steps.length > 1 ? steps[1] : null
        const nextStepDueAt = nextStep ? calculateStepDueDate(nextStep.delay_days) : null

        // Create execution record for workflow
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
          logger.error('Failed to create workflow execution', {
            account_id: acc.id,
            error: execError?.message,
          })
          continue
        }

        executionId = execution.id

        // Execute step 1 immediately
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

        await supabase
          .from('playbook_executions')
          .update(updatePayload)
          .eq('id', execution.id)

        executionResults.push({
          execution_id: execution.id,
          account_id: acc.id,
          status: workflowDone ? (isCompleted ? 'completed' : 'failed') : 'running',
          steps: totalSteps,
          completed: isCompleted ? 1 : 0,
          failed: isCompleted ? 0 : 1,
        })
      } else {
        // ── Standard playbook execution (unchanged) ──
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
          logger.error('Failed to create execution record', {
            account_id: acc.id,
            error: execError?.message,
          })
          continue
        }

        executionId = execution.id

        // Process actions sequentially
        const actionResults: ActionResult[] = []
        let completedSteps = 0
        let failedSteps = 0

        for (const action of actions) {
          // ── create_task: real HubSpot CRM task creation ──
          if (action.type === 'create_task') {
            const taskResult = await handleCreateTaskAction(
              supabase, action, acc, body.organization_id,
              hubspotConnected, hubspotToken, logger,
            )
            actionResults.push(taskResult)
            if (taskResult.status === 'completed') completedSteps++
            else if (taskResult.status === 'failed') failedSteps++
            continue
          }

          // ── slack_notify: real Slack message ──
          if (action.type === 'slack_notify') {
            try {
              const msg = buildSlackNotifyMessage(
                (action.config ?? {}) as { channel?: string; message?: string },
                acc as unknown as { id: string; stripe_customer_id?: string; health_score?: number | null; churn_risk_score?: number | null; expansion_score?: number | null; mrr_cents?: number | null },
                playbook.title,
              )
              await alertSlack(msg, { level: 'info' })
              const slackResult: ActionResult = {
                action_type: 'slack_notify', order: action.order, status: 'completed',
                message: `Slack notification sent for account ${acc.id}`,
                executed_at: new Date().toISOString(),
              }
              actionResults.push(slackResult)
              completedSteps++
            } catch (err) {
              const slackResult: ActionResult = {
                action_type: 'slack_notify', order: action.order, status: 'failed',
                message: `Slack notification failed: ${String(err)}`,
                executed_at: new Date().toISOString(),
              }
              actionResults.push(slackResult)
              failedSteps++
            }
            continue
          }

          // ── flag_for_review: set flag on account ──
          if (action.type === 'flag_for_review') {
            try {
              const { data: currentAccount } = await supabase
                .from('accounts')
                .select('flags')
                .eq('id', acc.id)
                .eq('organization_id', body.organization_id)
                .maybeSingle()

              const existingFlags: FlagEntry[] = (currentAccount?.flags as FlagEntry[]) ?? []
              const newFlag = buildFlagEntry(
                (action.config ?? {}) as { flag?: string; reason?: string },
                body.playbook_id,
                new Date(),
              )
              const updatedFlags = mergeFlag(existingFlags, newFlag)

              const { error: flagError } = await supabase
                .from('accounts')
                .update({ flags: updatedFlags })
                .eq('id', acc.id)
                .eq('organization_id', body.organization_id)

              const flagResult: ActionResult = {
                action_type: 'flag_for_review', order: action.order,
                status: flagError ? 'failed' : 'completed',
                message: flagError
                  ? `Flag update failed: ${flagError.message}`
                  : `Flag "${newFlag.flag}" set on account ${acc.id}`,
                executed_at: new Date().toISOString(),
              }
              actionResults.push(flagResult)
              if (flagError) failedSteps++
              else completedSteps++
            } catch (err) {
              actionResults.push({
                action_type: 'flag_for_review', order: action.order, status: 'failed',
                message: `Flag failed: ${String(err)}`, executed_at: new Date().toISOString(),
              })
              failedSteps++
            }
            continue
          }

          // ── log_note: insert into account_notes ──
          if (action.type === 'log_note') {
            try {
              const note = buildNoteEntry(
                (action.config ?? {}) as { title?: string; body?: string },
                acc as unknown as { id: string; stripe_customer_id?: string; health_score?: number | null; churn_risk_score?: number | null; expansion_score?: number | null; mrr_cents?: number | null },
                body.organization_id,
                body.playbook_id,
                execution.id,
                playbook.title,
              )

              const { error: noteError } = await supabase
                .from('account_notes')
                .insert(note)

              const noteResult: ActionResult = {
                action_type: 'log_note', order: action.order,
                status: noteError ? 'failed' : 'completed',
                message: noteError
                  ? `Note insert failed: ${noteError.message}`
                  : `Note logged for account ${acc.id}`,
                executed_at: new Date().toISOString(),
              }
              actionResults.push(noteResult)
              if (noteError) failedSteps++
              else completedSteps++
            } catch (err) {
              actionResults.push({
                action_type: 'log_note', order: action.order, status: 'failed',
                message: `Note failed: ${String(err)}`, executed_at: new Date().toISOString(),
              })
              failedSteps++
            }
            continue
          }

          // ── Fallback: log-only for unimplemented actions ──
          const result = executeAction(action, acc, {
            playbookId: body.playbook_id,
            executionId: execution.id,
          })
          actionResults.push(result)
          if (result.status === 'completed') completedSteps++
          else if (result.status === 'failed') failedSteps++
        }

        // Determine final status
        let finalStatus: string
        if (failedSteps === 0) finalStatus = 'completed'
        else if (completedSteps === 0) finalStatus = 'failed'
        else finalStatus = 'partially_completed'

        // Update execution record
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
          logger.error('Failed to update execution record', {
            execution_id: execution.id,
            error: updateError.message,
          })
        }

        executionResults.push({
          execution_id: execution.id,
          account_id: acc.id,
          status: finalStatus,
          steps: actions.length,
          completed: completedSteps,
          failed: failedSteps,
        })
      }
    } catch (err) {
      // Mark execution as failed if it was created
      if (executionId) {
        await supabase
          .from('playbook_executions')
          .update({
            execution_status: 'failed',
            completed_at: new Date().toISOString(),
          })
          .eq('id', executionId)
      }
      logger.error('Execution failed for account', {
        account_id: acc.id,
        execution_id: executionId,
        error: err instanceof Error ? err.message : String(err),
      })
      executionResults.push({
        execution_id: executionId ?? 'unknown',
        account_id: acc.id,
        status: 'failed',
        steps: totalSteps,
        completed: 0,
        failed: totalSteps,
      })
    }
  }

  // ── Update playbook KPIs ────────────────────────────────

  const accountsTargeted = finalAccounts.length
  const accountsReached = executionResults.filter((r) => r.status !== 'failed').length

  const { error: kpiError } = await supabase
    .from('playbooks')
    .update({
      accounts_eligible: (playbook.accounts_eligible ?? 0) + eligibleAccounts.length,
      accounts_targeted: (playbook.accounts_targeted ?? 0) + accountsTargeted,
      accounts_reached: (playbook.accounts_reached ?? 0) + accountsReached,
      execution_count: (playbook.execution_count ?? 0) + 1,
      last_executed_at: new Date().toISOString(),
    })
    .eq('id', body.playbook_id)

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

  // ── Webhook sortant pour chaque exécution réussie ─────
  const webhookEvent = mapPlaybookToEvent(playbook.trigger_conditions)
  if (webhookEvent) {
    for (const result of executionResults) {
      if (result.status === 'failed') continue
      const acc = finalAccounts.find((a: Record<string, unknown>) => a.id === result.account_id) as Record<string, unknown> | undefined
      if (!acc || !acc.stripe_customer_id) continue
      await dispatchWebhook(supabase, body.organization_id, webhookEvent, {
        account_id: acc.id as string,
        stripe_customer_id: acc.stripe_customer_id as string,
        ...(acc.hubspot_company_id ? { hubspot_company_id: acc.hubspot_company_id as string } : {}),
      }, {
        health_score: (acc.health_score as number) ?? 0,
        churn_risk_score: (acc.churn_risk_score as number) ?? 0,
        expansion_score: (acc.expansion_score as number) ?? 0,
        mrr_cents: (acc.mrr_cents as number) ?? 0,
        trigger_reason: `Playbook "${playbook.title}" exécuté`,
      }, {
        playbook_id: playbook.id,
        playbook_name: playbook.title,
      })
    }
  }

  logger.info('Playbook execution completed', {
    executions_created: executionResults.length,
    failed: failedCount,
  })

  const hasMore = (body.account_ids?.length ?? 0) > MAX_ACCOUNTS_PER_RUN

  return jsonResponse({
    success: true,
    playbook_id: body.playbook_id,
    executions_created: executionResults.length,
    has_more: hasMore,
    results: executionResults,
  })
})
