// ============================================================
// Workflow Executor — Execution impure des steps workflow
// Gere l'envoi d'emails via Resend et l'interpolation de templates
// Delegue les actions non-email a executeAction() (pure)
// ============================================================

import { sendEmail } from './resend.ts'
import type { WorkflowStep, AccountData, ActionResult, PlaybookAction } from './playbook-engine.ts'
import { executeAction } from './playbook-engine.ts'

export interface WorkflowStepContext {
  playbookId: string
  executionId: string
  csmEmail: string
  csmName?: string
  orgName: string
}

/**
 * Execute un step de workflow.
 * Pour send_email : interpole le template et envoie via Resend.
 * Pour les autres types : delegue a executeAction() (log-only V1).
 */
export async function executeWorkflowStep(
  step: WorkflowStep,
  account: AccountData,
  context: WorkflowStepContext,
): Promise<ActionResult> {
  if (step.action_type === 'send_email') {
    return executeEmailStep(step, account, context)
  }

  // Pour les actions non-email, deleguer au moteur existant
  const action: PlaybookAction = {
    type: step.action_type,
    config: step.config,
    order: step.step_order,
  }
  return executeAction(action, account, {
    playbookId: context.playbookId,
    executionId: context.executionId,
  })
}

async function executeEmailStep(
  step: WorkflowStep,
  account: AccountData,
  context: WorkflowStepContext,
): Promise<ActionResult> {
  const subject = interpolateTemplate(
    (step.config.email_subject as string) || '',
    account,
    context,
  )
  const html = interpolateTemplate(
    (step.config.email_body_html as string) || '',
    account,
    context,
  )
  const fromName = (step.config.email_from_name as string) || 'Sentio AI'
  const replyTo = step.config.email_reply_to as string | undefined

  const result = await sendEmail({
    to: context.csmEmail,
    subject: subject,
    html: html,
    from_name: fromName,
    reply_to: replyTo,
  })

  return {
    action_type: 'send_email',
    order: step.step_order,
    status: result.success ? 'completed' : 'failed',
    message: result.success
      ? 'Email sent to ' + context.csmEmail + ': ' + subject +
        (result.log_only ? ' (log-only)' : '') +
        ' (resend_id=' + (result.resend_message_id || 'none') + ')'
      : 'Email failed: ' + (result.error || 'unknown error'),
    executed_at: new Date().toISOString(),
  }
}

/**
 * Interpole les variables de template dans une chaine.
 * Variables supportees :
 * - {{account.field}} — champs de AccountData
 * - {{account.mrr_eur}} — MRR en euros (mrr_cents / 100)
 * - {{account.arr_eur}} — ARR en euros (arr_cents / 100)
 * - {{account.seat_usage_pct}} — pourcentage d'utilisation sieges
 * - {{org.name}} — nom de l'organisation
 * - {{csm.name}} — nom du CSM
 * - {{csm.email}} — email du CSM
 */
export function interpolateTemplate(
  template: string,
  account: AccountData,
  context: WorkflowStepContext,
): string {
  if (!template) return ''

  const accountRecord = account as unknown as Record<string, unknown>

  let result = template

  // {{account.mrr_eur}} — conversion centimes vers euros
  result = result.replace(/\{\{account\.mrr_eur\}\}/g,
    String(((account.mrr_cents || 0) / 100).toFixed(0)))

  // {{account.arr_eur}} — conversion centimes vers euros
  result = result.replace(/\{\{account\.arr_eur\}\}/g,
    String(((account.arr_cents || 0) / 100).toFixed(0)))

  // {{account.seat_usage_pct}} — pourcentage d'utilisation sieges
  const seatPct = account.seat_limit && account.seat_limit > 0
    ? Math.round(((account.seat_count || 0) / account.seat_limit) * 100)
    : 0
  result = result.replace(/\{\{account\.seat_usage_pct\}\}/g, String(seatPct))

  // {{account.field}} — champs generiques
  result = result.replace(/\{\{account\.(\w+)\}\}/g, function(_match, field) {
    const value = accountRecord[field]
    if (value === null || value === undefined) return ''
    return String(value)
  })

  // {{org.name}}
  result = result.replace(/\{\{org\.name\}\}/g, context.orgName || '')

  // {{csm.name}}
  result = result.replace(/\{\{csm\.name\}\}/g, context.csmName || '')

  // {{csm.email}}
  result = result.replace(/\{\{csm\.email\}\}/g, context.csmEmail || '')

  return result
}
