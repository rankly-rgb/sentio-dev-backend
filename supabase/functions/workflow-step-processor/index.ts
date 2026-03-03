// ============================================================
// Edge Function : workflow-step-processor
// Cron (toutes les 15 min) — traite les steps de workflow en attente
// Pattern : acquireCronLock → process steps → releaseCronLock
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { acquireCronLock, releaseCronLock } from '../_shared/cron-lock.ts'
import { createLogger } from '../_shared/structured-logger.ts'
import { alertSlack } from '../_shared/slack-alert.ts'
import { calculateStepDueDate, type WorkflowStep, type AccountData } from '../_shared/playbook-engine.ts'
import { executeWorkflowStep } from '../_shared/workflow-executor.ts'

const LOCK_KEY = 'workflow-step-processor'
const LOCK_TTL_SECONDS = 600
const MAX_EXECUTIONS_PER_RUN = 100

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const correlationId = crypto.randomUUID()
  const logger = createLogger({
    correlation_id: correlationId,
    function_name: 'workflow-step-processor',
  })

  let supabase: SupabaseClient
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('Failed to create Supabase client', { error: msg })
    return errorResponse('Server configuration error', 500)
  }

  // Acquire cron lock
  const locked = await acquireCronLock(supabase, LOCK_KEY, LOCK_TTL_SECONDS)
  if (!locked) {
    return jsonResponse({ message: 'Another instance is running' }, 409)
  }

  let processedCount = 0
  let errorCount = 0

  try {
    // Find executions with pending steps
    const now = new Date().toISOString()
    const { data: pendingExecs, error: queryError } = await supabase
      .from('playbook_executions')
      .select('id, organization_id, playbook_id, account_id, current_step, completed_steps, failed_steps, total_steps, actions_completed, emails_sent')
      .eq('workflow_completed', false)
      .eq('execution_status', 'running')
      .lte('next_step_due_at', now)
      .order('next_step_due_at', { ascending: true })
      .limit(MAX_EXECUTIONS_PER_RUN)

    if (queryError) {
      logger.error('Failed to query pending executions', { error: queryError.message })
      throw queryError
    }

    if (!pendingExecs || pendingExecs.length === 0) {
      logger.info('No pending workflow steps to process')
      return jsonResponse({ processed: 0, errors: 0 })
    }

    logger.info('Processing pending workflow steps', { count: pendingExecs.length })

    // Group by playbook_id to batch-load playbooks
    const playbookIds = Array.from(new Set(pendingExecs.map((e: Record<string, unknown>) => e.playbook_id as string)))
    const { data: playbooks } = await supabase
      .from('playbooks')
      .select('id, steps, organization_id, title')
      .in('id', playbookIds)

    const playbookMap = new Map<string, Record<string, unknown>>()
    for (const pb of (playbooks || [])) {
      playbookMap.set(pb.id, pb)
    }

    // Batch-load org names
    const orgIds = Array.from(new Set(pendingExecs.map((e: Record<string, unknown>) => e.organization_id as string)))
    const { data: orgs } = await supabase
      .from('organizations')
      .select('id, name')
      .in('id', orgIds)
    const orgMap = new Map<string, string>()
    for (const org of (orgs || [])) {
      orgMap.set(org.id, org.name || '')
    }

    // Batch-load account data
    const accountIds = Array.from(new Set(pendingExecs.map((e: Record<string, unknown>) => e.account_id as string)))
    const { data: accounts } = await supabase
      .from('accounts')
      .select('id, organization_id, health_score, churn_risk_score, expansion_score, product_usage_score, mrr_cents, arr_cents, plan_tier, seat_count, seat_limit, contract_start_date, contract_end_date, created_at')
      .in('id', accountIds)
    const accountMap = new Map<string, AccountData>()
    for (const acc of (accounts || [])) {
      accountMap.set(acc.id, acc as AccountData)
    }

    // Batch-load CSM profiles per org
    const profileMap = new Map<string, { email: string; name: string }>()
    const { data: profiles } = await supabase
      .from('profiles_')
      .select('organization_id, email, full_name')
      .in('organization_id', orgIds)
    for (const p of (profiles || [])) {
      if (!profileMap.has(p.organization_id)) {
        profileMap.set(p.organization_id, {
          email: p.email || '',
          name: p.full_name || '',
        })
      }
    }

    // Process each pending execution
    for (const exec of pendingExecs) {
      try {
        const playbook = playbookMap.get(exec.playbook_id)
        if (!playbook || !playbook.steps) {
          logger.error('Playbook not found or has no steps', { execution_id: exec.id })
          errorCount++
          continue
        }

        const steps = (playbook.steps as WorkflowStep[]).sort((a, b) => a.step_order - b.step_order)
        const currentStepIndex = (exec.current_step as number) - 1
        const currentStep = steps[currentStepIndex]

        if (!currentStep) {
          // No more steps, mark as completed
          await supabase
            .from('playbook_executions')
            .update({
              workflow_completed: true,
              execution_status: 'completed',
              completed_at: new Date().toISOString(),
            })
            .eq('id', exec.id)
          processedCount++
          continue
        }

        const account = accountMap.get(exec.account_id)
        if (!account) {
          logger.error('Account not found', { execution_id: exec.id, account_id: exec.account_id })
          errorCount++
          continue
        }

        const orgProfile = profileMap.get(exec.organization_id) || { email: '', name: '' }
        const orgName = orgMap.get(exec.organization_id) || ''

        // Execute the current step
        const stepResult = await executeWorkflowStep(currentStep, account, {
          playbookId: exec.playbook_id,
          executionId: exec.id,
          csmEmail: orgProfile.email,
          csmName: orgProfile.name,
          orgName: orgName,
        })

        // Calculate next step
        const nextStepIndex = currentStepIndex + 1
        const nextStep = nextStepIndex < steps.length ? steps[nextStepIndex] : null
        const isLastStep = !nextStep
        const isCompleted = stepResult.status === 'completed'

        // Update execution
        const prevActions = (exec.actions_completed as unknown[]) || []
        const newCompletedSteps = (exec.completed_steps as number) + (isCompleted ? 1 : 0)
        const newFailedSteps = (exec.failed_steps as number) + (isCompleted ? 0 : 1)
        const newEmailsSent = (exec.emails_sent as number) + (currentStep.action_type === 'send_email' && isCompleted ? 1 : 0)

        const updatePayload: Record<string, unknown> = {
          current_step: (exec.current_step as number) + 1,
          completed_steps: newCompletedSteps,
          failed_steps: newFailedSteps,
          actions_completed: [...prevActions, stepResult],
          emails_sent: newEmailsSent,
        }

        if (currentStep.action_type === 'send_email' && isCompleted) {
          updatePayload.last_email_sent_at = new Date().toISOString()
        }

        if (isLastStep) {
          updatePayload.workflow_completed = true
          updatePayload.completed_at = new Date().toISOString()
          updatePayload.execution_status = newFailedSteps === 0 ? 'completed'
            : newCompletedSteps === 0 ? 'failed'
            : 'partially_completed'
        } else {
          updatePayload.next_step_due_at = calculateStepDueDate(nextStep.delay_days)
        }

        await supabase
          .from('playbook_executions')
          .update(updatePayload)
          .eq('id', exec.id)

        // Log email send if applicable
        if (currentStep.action_type === 'send_email') {
          await supabase
            .from('email_send_log')
            .insert({
              organization_id: exec.organization_id,
              execution_id: exec.id,
              account_id: exec.account_id,
              playbook_id: exec.playbook_id,
              email_to: orgProfile.email,
              email_subject: (currentStep.config.email_subject as string) || '',
              email_status: isCompleted ? 'sent' : 'failed',
              step_order: currentStep.step_order,
              error_message: isCompleted ? null : stepResult.message,
            })
        }

        processedCount++
      } catch (err) {
        errorCount++
        logger.error('Failed to process workflow step', {
          execution_id: exec.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (errorCount > 0) {
      await alertSlack(
        'workflow-step-processor: ' + errorCount + '/' + pendingExecs.length + ' steps failed',
        { level: 'warning' },
      )
    }

    logger.info('Workflow step processing completed', { processed: processedCount, errors: errorCount })
  } catch (err) {
    logger.error('Workflow step processor failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    await alertSlack(
      'workflow-step-processor crashed: ' + (err instanceof Error ? err.message : String(err)),
      { level: 'error' },
    )
  } finally {
    await releaseCronLock(supabase, LOCK_KEY)
  }

  return jsonResponse({ processed: processedCount, errors: errorCount })
})
