// ============================================================
// Pure helpers for playbook action execution (slack_notify, flag_for_review, log_note)
// No Deno/JSR imports — testable with Vitest
// ============================================================

// ── Types ────────────────────────────────────────────────────

export interface SlackNotifyConfig {
  channel?: string
  message?: string
}

export interface FlagForReviewConfig {
  flag?: string
  reason?: string
}

export interface LogNoteConfig {
  title?: string
  body?: string
}

export interface AccountContext {
  id: string
  stripe_customer_id?: string
  health_score?: number | null
  churn_risk_score?: number | null
  expansion_score?: number | null
  mrr_cents?: number | null
}

export interface FlagEntry {
  flag: string
  set_at: string
  playbook_id: string | null
  reason: string
}

export interface NoteEntry {
  account_id: string
  organization_id: string
  note_type: 'playbook_action'
  title: string
  body: string
  source: 'playbook'
  playbook_id: string | null
  execution_id: string | null
}

// ── Slack notify helpers ─────────────────────────────────────

/**
 * Builds a Slack message for a playbook slack_notify action.
 * Zero-PII: only stripe_customer_id and scores, never names/emails.
 */
export function buildSlackNotifyMessage(
  config: SlackNotifyConfig,
  account: AccountContext,
  playbookTitle: string,
): string {
  const mrrEur = account.mrr_cents != null ? (account.mrr_cents / 100).toFixed(0) : '?'
  const churn = account.churn_risk_score ?? '?'
  const health = account.health_score ?? '?'

  if (config.message) {
    // User-defined message template with variable substitution
    return config.message
      .replace('{stripe_customer_id}', account.stripe_customer_id ?? '?')
      .replace('{mrr_eur}', mrrEur)
      .replace('{churn_risk}', String(churn))
      .replace('{health_score}', String(health))
      .replace('{playbook}', playbookTitle)
  }

  // Default message format
  const channel = config.channel ? ` [#${config.channel}]` : ''
  return `📋 Playbook "${playbookTitle}"${channel} — ` +
    `Compte ${account.stripe_customer_id ?? account.id} | ` +
    `Santé: ${health} | Churn: ${churn}% | MRR: ${mrrEur} €`
}

// ── Flag for review helpers ──────────────────────────────────

/**
 * Builds a flag entry to append to accounts.flags JSONB array.
 */
export function buildFlagEntry(
  config: FlagForReviewConfig,
  playbookId: string | null,
  now: Date,
): FlagEntry {
  return {
    flag: config.flag ?? 'review_needed',
    set_at: now.toISOString(),
    playbook_id: playbookId,
    reason: config.reason ?? 'Signalé par playbook',
  }
}

/**
 * Merges a new flag into an existing flags array, avoiding duplicates
 * by flag name. If the same flag already exists, it is updated (set_at refreshed).
 */
export function mergeFlag(
  existingFlags: FlagEntry[],
  newFlag: FlagEntry,
): FlagEntry[] {
  const filtered = (existingFlags ?? []).filter(f => f.flag !== newFlag.flag)
  return [...filtered, newFlag]
}

/**
 * Checks if a flag already exists in the flags array.
 */
export function hasFlag(flags: FlagEntry[], flagName: string): boolean {
  return (flags ?? []).some(f => f.flag === flagName)
}

// ── Log note helpers ─────────────────────────────────────────

/**
 * Builds an account_notes row to insert.
 * Zero-PII: note body contains only scores and MRR, never names/emails.
 */
export function buildNoteEntry(
  config: LogNoteConfig,
  account: AccountContext,
  orgId: string,
  playbookId: string | null,
  executionId: string | null,
  playbookTitle: string,
): NoteEntry {
  const mrrEur = account.mrr_cents != null ? (account.mrr_cents / 100).toFixed(0) : '?'
  const defaultTitle = `Note — ${playbookTitle}`
  const defaultBody =
    `Action playbook "${playbookTitle}" exécutée. ` +
    `Santé: ${account.health_score ?? '?'}, ` +
    `Churn: ${account.churn_risk_score ?? '?'}%, ` +
    `MRR: ${mrrEur} €`

  return {
    account_id: account.id,
    organization_id: orgId,
    note_type: 'playbook_action',
    title: config.title ?? defaultTitle,
    body: config.body ?? defaultBody,
    source: 'playbook',
    playbook_id: playbookId,
    execution_id: executionId,
  }
}
