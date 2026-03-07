// ============================================================
// Webhook Helpers — Fonctions pures pour webhooks sortants
// Testables avec Vitest (pas d'imports Deno/jsr)
// ============================================================

export type WebhookEvent =
  | 'churn_risk_critical'
  | 'payment_failed'
  | 'renewal_reminder'
  | 'expansion_opportunity'
  | 'health_score_drop'
  | 'onboarding_completed'

export interface WebhookAccountData {
  account_id: string
  stripe_customer_id: string
  hubspot_company_id?: string
}

export interface WebhookSignals {
  health_score: number
  churn_risk_score: number
  expansion_score: number
  mrr_cents: number
  trigger_reason: string
}

export interface WebhookPayload {
  event: WebhookEvent | 'test'
  triggered_at: string
  organization_id: string
  account: WebhookAccountData
  signals: WebhookSignals
  metadata?: Record<string, unknown>
}

export const VALID_EVENTS: WebhookEvent[] = [
  'churn_risk_critical',
  'payment_failed',
  'renewal_reminder',
  'expansion_opportunity',
  'health_score_drop',
  'onboarding_completed',
]

const MAX_FAILURE_COUNT = 5

export function buildPayload(
  event: WebhookEvent,
  organizationId: string,
  account: WebhookAccountData,
  signals: WebhookSignals,
  metadata?: Record<string, unknown>,
): WebhookPayload {
  return {
    event,
    triggered_at: new Date().toISOString(),
    organization_id: organizationId,
    account: {
      account_id: account.account_id,
      stripe_customer_id: account.stripe_customer_id,
      ...(account.hubspot_company_id ? { hubspot_company_id: account.hubspot_company_id } : {}),
    },
    signals: {
      health_score: signals.health_score,
      churn_risk_score: signals.churn_risk_score,
      expansion_score: signals.expansion_score,
      mrr_cents: signals.mrr_cents,
      trigger_reason: signals.trigger_reason,
    },
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  }
}

export function isEventActive(event: WebhookEvent, activeEvents: unknown[]): boolean {
  return activeEvents.includes(event)
}

export function shouldDisableWebhook(failureCount: number): boolean {
  return failureCount >= MAX_FAILURE_COUNT
}

export async function computeHmacSignature(
  payload: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function mapPlaybookToEvent(triggerConditions: Record<string, unknown> | null): WebhookEvent | null {
  if (!triggerConditions) return null
  const conditions = (triggerConditions.conditions ?? []) as Array<Record<string, unknown>>
  for (const c of conditions) {
    if (c.field === 'churn_risk_score' && (c.operator === 'gte' || c.operator === 'gt')) {
      return 'churn_risk_critical'
    }
    if (c.field === 'health_score' && (c.operator === 'lte' || c.operator === 'lt')) {
      return 'health_score_drop'
    }
    if (c.field === 'expansion_score' && (c.operator === 'gte' || c.operator === 'gt')) {
      return 'expansion_opportunity'
    }
  }
  return null
}

const PII_FIELDS = ['email', 'name', 'first_name', 'last_name', 'phone', 'address', 'ip', 'ip_address']

export function containsPII(payload: unknown): boolean {
  if (payload == null || typeof payload !== 'object') return false
  for (const key of Object.keys(payload as Record<string, unknown>)) {
    if (PII_FIELDS.includes(key.toLowerCase())) return true
    const val = (payload as Record<string, unknown>)[key]
    if (typeof val === 'object' && val !== null && containsPII(val)) return true
  }
  return false
}
