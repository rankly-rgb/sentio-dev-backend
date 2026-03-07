// ============================================================
// Webhook Dispatcher — Module partagé pour webhooks sortants
// Envoie des webhooks signés HMAC-SHA256 aux endpoints clients
// Zero-PII : uniquement stripe_customer_id + signaux analytiques
// ============================================================

import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { fetchWithTimeout } from './fetch-with-timeout.ts'
import { retryWithBackoff } from './retry-with-backoff.ts'
import { CircuitBreaker } from './circuit-breaker.ts'
import { alertSlack } from './slack-alert.ts'

// Re-export pure functions from webhook-helpers (testables sans Deno)
export {
  buildPayload,
  isEventActive,
  shouldDisableWebhook,
  computeHmacSignature,
  mapPlaybookToEvent,
  containsPII,
  VALID_EVENTS,
} from './webhook-helpers.ts'

export type {
  WebhookEvent,
  WebhookAccountData,
  WebhookSignals,
  WebhookPayload,
} from './webhook-helpers.ts'

import {
  buildPayload,
  isEventActive,
  shouldDisableWebhook,
  computeHmacSignature,
  type WebhookEvent,
  type WebhookAccountData,
  type WebhookSignals,
} from './webhook-helpers.ts'

interface WebhookConfig {
  id: string
  organization_id: string
  endpoint_url: string
  secret: string
  active_events: WebhookEvent[]
  is_active: boolean
  failure_count: number
}

// ── Circuit breaker singleton ───────────────────────────────

const outboundCB = new CircuitBreaker({
  name: 'outbound-webhook',
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
})

// ── Main dispatcher ─────────────────────────────────────────

export async function dispatchWebhook(
  supabase: SupabaseClient,
  organizationId: string,
  event: WebhookEvent,
  account: WebhookAccountData,
  signals: WebhookSignals,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    // 1. Fetch webhook config for this org
    const { data: config, error: cfgError } = await supabase
      .from('webhook_configs')
      .select('id, organization_id, endpoint_url, webhook_secret, active_events, is_active, failure_count')
      .eq('organization_id', organizationId)
      .eq('provider', 'webhook')
      .eq('is_active', true)
      .maybeSingle()

    if (cfgError || !config) return // No active webhook config — silent no-op
    if (!config.endpoint_url) return

    const wc: WebhookConfig = {
      id: config.id,
      organization_id: config.organization_id,
      endpoint_url: config.endpoint_url,
      secret: config.webhook_secret,
      active_events: config.active_events ?? [],
      is_active: config.is_active,
      failure_count: config.failure_count ?? 0,
    }

    // 2. Check event is subscribed
    if (!isEventActive(event, wc.active_events ?? [])) return

    // 3. Build payload
    const payload = buildPayload(event, organizationId, account, signals, metadata)
    const payloadStr = JSON.stringify(payload)

    // 4. Sign
    const signature = await computeHmacSignature(payloadStr, wc.secret)
    const timestamp = Math.floor(Date.now() / 1000).toString()

    // 5. Send with retry + circuit breaker
    await retryWithBackoff(
      () => outboundCB.execute(async () => {
        const resp = await fetchWithTimeout(
          wc.endpoint_url,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Sentio-Event': event,
              'X-Sentio-Signature': signature,
              'X-Sentio-Timestamp': timestamp,
              'X-Sentio-Version': '1',
            },
            body: payloadStr,
          },
          10_000,
        )
        if (!resp.ok) {
          throw new Error(`Webhook endpoint returned ${resp.status}`)
        }
        return resp
      }),
      { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 10_000 },
    )

    // 6. Success — reset failure_count + update last_triggered_at
    await supabase
      .from('webhook_configs')
      .update({ last_triggered_at: new Date().toISOString(), failure_count: 0 })
      .eq('id', wc.id)
  } catch (err) {
    // 7. Failure — increment failure_count, DLQ, auto-disable
    await handleWebhookFailure(supabase, organizationId, event, account, signals, err)
  }
}

async function handleWebhookFailure(
  supabase: SupabaseClient,
  organizationId: string,
  event: WebhookEvent,
  account: WebhookAccountData,
  signals: WebhookSignals,
  err: unknown,
): Promise<void> {
  const errorMessage = err instanceof Error ? err.message : String(err)

  try {
    // Increment failure_count atomically
    const { data: updated } = await supabase
      .rpc('increment_webhook_failure', { p_org_id: organizationId })

    // If failure count exceeds threshold, disable + alert
    const newFailureCount = (updated as number) ?? 0
    if (shouldDisableWebhook(newFailureCount)) {
      await supabase
        .from('webhook_configs')
        .update({ is_active: false })
        .eq('organization_id', organizationId)
        .eq('provider', 'webhook')

      await alertSlack(
        `Webhook sortant désactivé pour org ${organizationId} après ${newFailureCount} échecs consécutifs`,
        { level: 'critical' },
      )
    }

    // Write to DLQ
    await supabase.from('webhook_dead_letter').insert({
      organization_id: organizationId,
      provider: 'outbound_webhook',
      event_type: event,
      payload: { account, signals },
      error_message: errorMessage,
      retry_count: 0,
      max_retries: 3,
    })
  } catch {
    // Last resort — never crash the caller
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Failed to handle webhook failure',
        organization_id: organizationId,
        event,
        error: errorMessage,
      }),
    )
  }
}
