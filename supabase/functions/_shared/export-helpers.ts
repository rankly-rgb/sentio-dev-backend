// ============================================================
// Pure helper functions for export-playbook-accounts
// Extracted to _shared for testability (no Deno/jsr imports)
// ============================================================

export interface AccountRow {
  stripe_customer_id: string
  hubspot_company_id: string | null
  plan_tier: string | null
  mrr_usd: number
  health_score: number | null
  churn_risk_score: number | null
  expansion_score: number | null
  segment: string | null
  days_to_renewal: number | null
  billing_interval: string | null
  trigger_reason: string
  suggested_playbook: string
  suggested_action: string
  priority: 'P0' | 'P1' | 'P2'
  last_login_days_ago: number | null
  open_ticket_count: number | null
  nps_score: number | null
  hubspot_import_note: string
}

export function computePriority(
  churnRisk: number | null,
  daysToRenewal: number | null
): 'P0' | 'P1' | 'P2' {
  const risk = churnRisk ?? 0
  if (risk >= 70 && daysToRenewal !== null && daysToRenewal < 30) return 'P0'
  if (risk >= 50 || (daysToRenewal !== null && daysToRenewal < 60)) return 'P1'
  return 'P2'
}

export function computeDaysToRenewal(
  contractEndDate: string | null,
  billingInterval: string | null
): number | null {
  if (!contractEndDate || billingInterval === 'monthly') return null
  const end = new Date(contractEndDate)
  const now = new Date()
  const diffMs = end.getTime() - now.getTime()
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24))
}

export function buildTriggerReason(signals: {
  hasUnpaidInvoice: boolean
  unpaidDays: number | null
  loginDecline: boolean
  lastLoginDaysAgo: number | null
  daysToRenewal: number | null
  churnRisk: number | null
  healthScore: number | null
}): string {
  const parts: string[] = []

  if (signals.hasUnpaidInvoice && signals.unpaidDays !== null) {
    parts.push(`Unpaid invoice for ${signals.unpaidDays}d`)
  }
  if (signals.loginDecline || (signals.lastLoginDaysAgo !== null && signals.lastLoginDaysAgo > 14)) {
    parts.push('Login activity declining')
  }
  if (signals.daysToRenewal !== null && signals.daysToRenewal <= 30) {
    parts.push(`Renews in ${signals.daysToRenewal}d`)
  }
  if (signals.churnRisk !== null && signals.churnRisk >= 70) {
    parts.push(`Critical churn risk (${Math.round(signals.churnRisk)}/100)`)
  }
  if (signals.healthScore !== null && signals.healthScore < 40) {
    parts.push(`Low health score (${Math.round(signals.healthScore)}/100)`)
  }

  return parts.length > 0 ? parts.join(' · ') : 'No active signal'
}

export function buildHubspotImportNote(
  healthScore: number | null,
  churnRisk: number | null,
  priority: 'P0' | 'P1' | 'P2',
  suggestedAction: string
): string {
  const hs = healthScore !== null ? Math.round(healthScore) : 'N/A'

  if (priority === 'P0') {
    return `This account has a critical churn risk. Health score: ${hs}/100. Priority action: ${suggestedAction.toLowerCase()}.`
  }
  if (priority === 'P1') {
    return `This account needs prompt attention. Health score: ${hs}/100. Recommended action: ${suggestedAction.toLowerCase()}.`
  }
  return `Account under watch. Health score: ${hs}/100. No urgent action required.`
}

export function sortAccounts(accounts: AccountRow[]): AccountRow[] {
  const priorityOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2 }
  return accounts.sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 3
    const pb = priorityOrder[b.priority] ?? 3
    if (pa !== pb) return pa - pb
    return (b.mrr_usd ?? 0) - (a.mrr_usd ?? 0)
  })
}

export const CSV_COLUMNS = [
  'stripe_customer_id', 'hubspot_company_id', 'plan_tier',
  'mrr_usd', 'health_score', 'churn_risk_score', 'expansion_score',
  'segment', 'days_to_renewal', 'billing_interval',
  'trigger_reason', 'suggested_playbook', 'suggested_action', 'priority',
  'last_login_days_ago', 'open_ticket_count', 'nps_score',
  'hubspot_import_note',
] as const

export function buildCsv(accounts: AccountRow[]): string {
  const header = CSV_COLUMNS.join(',')
  const rows = accounts.map((acc) =>
    CSV_COLUMNS.map((col) => {
      const val = acc[col as keyof AccountRow]
      if (val === null || val === undefined) return ''
      const str = String(val)
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`
      }
      return str
    }).join(',')
  )
  return [header, ...rows].join('\n')
}

export function formatActionType(type: string, config?: Record<string, unknown>): string {
  const labels: Record<string, string> = {
    slack_notify: 'Slack notification',
    create_task: 'Create task',
    assign_owner: 'Assign owner',
    update_tag: 'Update tag',
    log_note: 'Add note',
    schedule_review: 'Schedule review',
    flag_for_review: 'Flag for review',
  }
  const label = labels[type] || type
  if (config?.title && typeof config.title === 'string') {
    return `${label} : ${config.title}`
  }
  return label
}
