// ============================================================
// Playbook Approval Helpers — Pure functions for human-in-the-loop
// Semi-automated playbook approval/rejection logic
// No Deno/jsr imports — testable with Vitest
// ============================================================

/** Execution status that allows approval or rejection */
const APPROVABLE_STATUS = 'pending_approval'

/**
 * Determines if an execution can be approved.
 * Only executions in 'pending_approval' status are approvable.
 */
export function canApprove(execution: { execution_status: string }): boolean {
  return execution.execution_status === APPROVABLE_STATUS
}

/**
 * Determines if an execution can be rejected.
 * Only executions in 'pending_approval' status are rejectable.
 */
export function canReject(execution: { execution_status: string }): boolean {
  return execution.execution_status === APPROVABLE_STATUS
}

/**
 * Checks if an execution's playbook_id matches the expected playbook ID from the URL.
 * Used to prevent accessing an execution via the wrong playbook route.
 */
export function isPlaybookMatch(
  execution: { playbook_id: string },
  urlPlaybookId: string,
): boolean {
  return execution.playbook_id === urlPlaybookId
}

/**
 * Builds the execution_log stored when a semi_automated execution is created.
 * Stores account IDs (UUIDs only, Zero-PII), planned actions, and trigger reasons.
 */
export function buildPendingApprovalLog(
  accountIds: string[],
  actions: unknown[],
  triggerReasons?: Record<string, string>,
): Record<string, unknown> {
  return {
    status: 'pending_approval',
    created_at: new Date().toISOString(),
    account_ids: accountIds,
    planned_actions: actions,
    trigger_reasons: triggerReasons ?? {},
    accounts_count: accountIds.length,
  }
}

/**
 * Merges rejection reason into an existing execution_log.
 * Preserves all existing log fields and adds rejection metadata.
 */
export function buildApprovalLog(
  executionLog: unknown,
  reason?: string,
): Record<string, unknown> {
  const existingLog = (executionLog && typeof executionLog === 'object' && !Array.isArray(executionLog))
    ? executionLog as Record<string, unknown>
    : {}

  return {
    ...existingLog,
    rejection_reason: reason ?? null,
    rejected_at: new Date().toISOString(),
    status: 'cancelled',
  }
}

/**
 * Builds the Slack notification message for a pending approval.
 * Includes account count, action types, and a link to the execution.
 */
export function buildApprovalSlackMessage(
  playbookTitle: string,
  accountsCount: number,
  actionTypes: string[],
  frontendUrl: string,
  playbookId: string,
  executionId: string,
): string {
  const actionList = actionTypes.length > 0
    ? actionTypes.join(', ')
    : 'aucune action configurée'

  const link = frontendUrl
    ? `\n🔗 ${frontendUrl}/dashboard/playbooks/${playbookId}/executions/${executionId}`
    : ''

  return (
    `[APPROVAL] Playbook "${playbookTitle}" en attente d'approbation\n` +
    `• ${accountsCount} compte(s) ciblé(s)\n` +
    `• Actions prévues : ${actionList}` +
    link
  )
}
