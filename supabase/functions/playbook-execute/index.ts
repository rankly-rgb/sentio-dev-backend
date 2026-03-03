// ============================================================
// Edge Function : playbook-execute
// Exécute un playbook sur des comptes spécifiques ou un segment
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
  type PlaybookAction,
  type AccountData,
  type ActionResult,
} from '../_shared/playbook-engine.ts'

const MAX_ACCOUNTS_PER_RUN = 200

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

  // Use auth org if not provided in body
  if (!body.organization_id && auth.organizationId) {
    body.organization_id = auth.organizationId
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
    .select('id, organization_id, health_score, churn_risk_score, expansion_score, product_usage_score, mrr_cents, arr_cents, plan_tier, seat_count, seat_limit, contract_start_date, contract_end_date, created_at')
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

  const actions = (playbook.actions as PlaybookAction[]).sort((a, b) => a.order - b.order)
  const executionSource = body.execution_source ?? 'manual'
  const executionResults: Array<{
    execution_id: string
    account_id: string
    status: string
    steps: number
    completed: number
    failed: number
  }> = []

  for (const account of finalAccounts) {
    const acc = account as AccountData

    // Create execution record
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

    // Process actions sequentially
    const actionResults: ActionResult[] = []
    let completedSteps = 0
    let failedSteps = 0

    for (const action of actions) {
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
