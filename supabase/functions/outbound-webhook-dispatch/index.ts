/*
 * OUTBOUND WEBHOOK DISPATCH
 *
 * Rôle : Envoie un payload JSON vers les destinations outbound configurées
 *        quand un account change de segment ou franchit un seuil de churn.
 *        Appelée par calculate-scores après mise à jour des scores.
 *
 * Input (POST JSON) :
 *   {
 *     organization_id: string (UUID)
 *     account_id: string (UUID)
 *     stripe_customer_id: string
 *     event_type: 'segment_change' | 'churn_threshold' | 'manual'
 *     segment_previous?: string
 *     segment_current: string
 *     health_score: number
 *     churn_risk_score: number
 *     expansion_score: number
 *     mrr_cents: number
 *   }
 *
 * Comportement :
 *   1. Récupère toutes les outbound_webhook_destinations actives de l'org
 *   2. Filtre celles dont le segment_current est dans trigger_segments
 *      OU dont churn_risk_score >= trigger_churn_threshold
 *   3. Pour chaque destination matchée, construit le payload et l'envoie
 *   4. Log le résultat dans outbound_webhook_logs
 *   5. En cas d'échec HTTP (non-2xx ou timeout), log dans webhook_dead_letter
 *
 * Payload envoyé vers la destination :
 *   {
 *     source: 'sentio_ai',
 *     event: 'account_risk_detected',
 *     account: {
 *       stripe_customer_id: string,
 *       segment: string,
 *       segment_previous?: string,
 *       health_score: number,
 *       churn_risk_score: number,
 *       expansion_score: number,
 *       mrr_cents: number,
 *       mrr_eur: number  -- mrr_cents / 100
 *     },
 *     triggered_at: string (ISO8601),
 *     organization_id: string
 *   }
 *
 * Zero-PII : le payload ne contient jamais d'email, nom, ou données personnelles.
 *
 * Output : { dispatched: number, failed: number, destinations: string[] }
 * Erreurs : 400 si payload invalide, 500 si erreur DB
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'
import { writeToDLQ } from '../_shared/dlq.ts'
import { withSentry } from '../_shared/sentry.ts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DispatchInput {
  organization_id: string
  account_id: string
  stripe_customer_id: string
  event_type: 'segment_change' | 'churn_threshold' | 'manual'
  segment_previous?: string
  segment_current: string
  health_score: number
  churn_risk_score: number
  expansion_score: number
  mrr_cents: number
}

interface OutboundDestination {
  id: string
  organization_id: string
  name: string
  destination_url: string
  provider: string
  is_active: boolean
  trigger_segments: string[]
  trigger_churn_threshold: number | null
  secret_header_name: string | null
  secret_header_value: string | null
}

interface OutboundPayload {
  source: 'sentio_ai'
  event: 'account_risk_detected'
  account: {
    stripe_customer_id: string
    segment: string
    segment_previous?: string
    health_score: number
    churn_risk_score: number
    expansion_score: number
    mrr_cents: number
    mrr_eur: number
  }
  triggered_at: string
  organization_id: string
}

const DISPATCH_TIMEOUT_MS = 10000

// ── Entrypoint ────────────────────────────────────────────────────────────────

Deno.serve(withSentry('outbound-webhook-dispatch', async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'outbound-webhook-dispatch', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  let input: DispatchInput
  try {
    input = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  // ── Validation ──────────────────────────────────────────────────────────────
  if (
    !input.organization_id ||
    !input.account_id ||
    !input.stripe_customer_id ||
    !input.event_type ||
    !input.segment_current ||
    typeof input.health_score !== 'number' ||
    typeof input.churn_risk_score !== 'number' ||
    typeof input.expansion_score !== 'number' ||
    typeof input.mrr_cents !== 'number'
  ) {
    return errorResponse('Missing required fields: organization_id, account_id, stripe_customer_id, event_type, segment_current, scores, mrr_cents', 400)
  }

  // ── Récupérer les destinations actives de l'org ─────────────────────────────
  const { data: destinations, error: destError } = await supabase
    .from('outbound_webhook_destinations')
    .select('id, organization_id, name, destination_url, provider, is_active, trigger_segments, trigger_churn_threshold, secret_header_name, secret_header_value')
    .eq('organization_id', input.organization_id)
    .eq('is_active', true)

  if (destError) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'outbound-webhook-dispatch',
      organization_id: input.organization_id,
      message: `destinations query failed: ${destError.message}`,
    }))
    return errorResponse('Database error', 500)
  }

  if (!destinations?.length) {
    return jsonResponse({ dispatched: 0, failed: 0, destinations: [] })
  }

  // ── Filtrer les destinations qui matchent l'événement ──────────────────────
  const matched = (destinations as OutboundDestination[]).filter((dest) => {
    const segmentMatch =
      dest.trigger_segments.length > 0 &&
      dest.trigger_segments.indexOf(input.segment_current) !== -1

    const churnMatch =
      dest.trigger_churn_threshold !== null &&
      input.churn_risk_score >= dest.trigger_churn_threshold

    return segmentMatch || churnMatch
  })

  if (matched.length === 0) {
    return jsonResponse({ dispatched: 0, failed: 0, destinations: [] })
  }

  // ── Construire le payload sortant (Zero-PII) ────────────────────────────────
  const triggeredAt = new Date().toISOString()

  const outboundPayload: OutboundPayload = {
    source: 'sentio_ai',
    event: 'account_risk_detected',
    account: {
      stripe_customer_id: input.stripe_customer_id,
      segment: input.segment_current,
      health_score: input.health_score,
      churn_risk_score: input.churn_risk_score,
      expansion_score: input.expansion_score,
      mrr_cents: input.mrr_cents,
      mrr_eur: Math.round(input.mrr_cents) / 100,
    },
    triggered_at: triggeredAt,
    organization_id: input.organization_id,
  }

  if (input.segment_previous !== undefined) {
    outboundPayload.account.segment_previous = input.segment_previous
  }

  const payloadBody = JSON.stringify(outboundPayload)

  // ── Envoyer en parallèle vers toutes les destinations matchées ──────────────
  const dispatchResults = await Promise.allSettled(
    matched.map(async (dest) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'Sentio-AI/1.0',
      }

      if (dest.secret_header_name && dest.secret_header_value) {
        headers[dest.secret_header_name] = dest.secret_header_value
      }

      let responseStatus: number | null = null
      let responseBody: string | null = null
      let success = false
      let errorMsg: string | null = null

      try {
        const response = await fetchWithTimeout(
          dest.destination_url,
          {
            method: 'POST',
            headers,
            body: payloadBody,
          },
          DISPATCH_TIMEOUT_MS,
        )

        responseStatus = response.status
        const rawBody = await response.text().catch(() => '')
        responseBody = rawBody.slice(0, 500)
        success = response.status >= 200 && response.status < 300
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err)
        console.error(JSON.stringify({
          level: 'error',
          function_name: 'outbound-webhook-dispatch',
          organization_id: input.organization_id,
          destination_id: dest.id,
          message: `dispatch failed: ${errorMsg}`,
        }))
      }

      // Log dans outbound_webhook_logs
      const { error: logError } = await supabase
        .from('outbound_webhook_logs')
        .insert({
          organization_id: input.organization_id,
          destination_id: dest.id,
          account_id: input.account_id,
          payload: outboundPayload,
          response_status: responseStatus,
          response_body: responseBody,
          success,
          triggered_by: input.event_type,
        })

      if (logError) {
        console.error(JSON.stringify({
          level: 'error',
          function_name: 'outbound-webhook-dispatch',
          organization_id: input.organization_id,
          message: `outbound_webhook_logs insert failed: ${logError.message}`,
        }))
      }

      // Si échec, écrire dans webhook_dead_letter pour retry
      if (!success) {
        const dlqError = errorMsg ?? `HTTP ${responseStatus}`
        await writeToDLQ(supabase, {
          organization_id: input.organization_id,
          provider: 'outbound',
          event_type: input.event_type,
          payload: {
            destination_id: dest.id,
            destination_url: dest.destination_url,
            original_payload: outboundPayload,
          },
          error_message: dlqError,
        })
      }

      // Mettre à jour last_triggered_at si succès
      if (success) {
        await supabase
          .from('outbound_webhook_destinations')
          .update({ last_triggered_at: triggeredAt })
          .eq('id', dest.id)
      }

      return { destination_id: dest.id, name: dest.name, success }
    }),
  )

  let dispatched = 0
  let failed = 0
  const dispatchedNames: string[] = []

  for (const result of dispatchResults) {
    if (result.status === 'fulfilled' && result.value.success) {
      dispatched++
      dispatchedNames.push(result.value.name)
    } else {
      failed++
    }
  }

  return jsonResponse({ dispatched, failed, destinations: dispatchedNames })
}))
