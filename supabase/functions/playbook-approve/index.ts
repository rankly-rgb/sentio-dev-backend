/*
 * PLAYBOOK APPROVE
 *
 * Role : Valide ou rejette un item de la playbook_approval_queue.
 *        Si approuve, appelle immediatement le connecteur configure.
 *
 * Auth : Bearer token (JWT ES256 utilisateur)
 *
 * Input PATCH JSON :
 *   {
 *     queue_item_id : string (UUID)  — requis
 *     action        : 'approved' | 'rejected'
 *     comment       : string         — optionnel
 *   }
 *
 * Comportement :
 *   1. Verifier auth + recuperer organization_id
 *   2. Charger l'item de queue (scope org)
 *   3. Verifier statut = 'pending' et expires_at > now
 *   4. Si expires_at < now -> mettre a jour statut 'expired', retourner 410
 *   5. Mettre a jour statut + reviewed_by + reviewed_at + comment
 *   6. Si action = 'approved' :
 *        a. Recuperer stripe_api_key depuis organizations.stripe_api_key
 *        b. Recuperer customer_email DEPUIS STRIPE API (transit only)
 *        c. Appeler le connecteur de la destination
 *        d. Logger dans playbook_execution_logs (sans email)
 *        e. Si echec connecteur -> DLQ (l'approbation reste committed)
 *        f. Mettre a jour last_triggered_at sur la destination
 *
 * Transit PII :
 *   L'email Stripe est recupere en memoire uniquement au moment de l'approbation.
 *   Il n'est JAMAIS ecrit dans aucune table, log, ou payload persiste.
 *
 * Output : { success: boolean, action: string, connector_result?: object }
 * Erreurs : 400 payload invalide, 401 non authentifie, 404 item inconnu,
 *           409 item deja traite, 410 item expire
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth } from '../_shared/auth.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'
import { writeToDLQ } from '../_shared/dlq.ts'
import { callBrevo } from '../_shared/connectors/brevo.ts'
import { callLemlist } from '../_shared/connectors/lemlist.ts'
import { callActiveCampaign } from '../_shared/connectors/activecampaign.ts'
import { callMailchimp } from '../_shared/connectors/mailchimp.ts'
import { callHubspot } from '../_shared/connectors/hubspot.ts'
import { callSlack } from '../_shared/connectors/slack.ts'
import { callCustom } from '../_shared/connectors/custom.ts'
import type { ConnectorConfig, ConnectorPayload, ConnectorResult } from '../_shared/connectors/types.ts'
import { truncate } from '../_shared/connectors/types.ts'

// ── Types ────────────────────────────────────────────────────

interface ApproveInput {
  queue_item_id: string
  action: 'approved' | 'rejected'
  comment?: string
}

interface QueueItem {
  id: string
  organization_id: string
  destination_id: string
  account_id: string
  stripe_customer_id: string
  connector: string
  trigger_reason: string
  segment_at_trigger: string | null
  segment_previous: string | null
  churn_risk_at_trigger: number | null
  health_score_at_trigger: number | null
  expansion_score_at_trigger: number | null
  mrr_cents_at_trigger: number | null
  status: string
  expires_at: string
}

interface DestinationRow {
  api_key_vault_key: string | null
  api_endpoint: string | null
  template_id: string | null
  message_template: string | null
  name: string
}

// ── Email transit depuis Stripe ──────────────────────────────

async function getCustomerEmailTransit(
  stripeCustomerId: string,
  stripeApiKey: string,
): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      `https://api.stripe.com/v1/customers/${stripeCustomerId}`,
      { headers: { Authorization: `Bearer ${stripeApiKey}` } },
      5000,
    )
    if (!res.ok) return null
    const data = await res.json()
    return typeof data.email === 'string' ? data.email : null
  } catch {
    return null
  }
}

// ── Dispatch connecteur ──────────────────────────────────────

async function runConnector(
  connector: string,
  payload: ConnectorPayload,
  config: ConnectorConfig,
): Promise<ConnectorResult> {
  switch (connector) {
    case 'brevo':          return callBrevo(payload, config)
    case 'lemlist':        return callLemlist(payload, config)
    case 'activecampaign': return callActiveCampaign(payload, config)
    case 'mailchimp':      return callMailchimp(payload, config)
    case 'hubspot':        return callHubspot(payload, config)
    case 'slack':          return callSlack(payload, config)
    case 'custom':         return callCustom(payload, config)
    default:
      return { success: false, error_message: `Connecteur inconnu : ${connector}` }
  }
}

// ── Entrypoint ───────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'PATCH') return errorResponse('Method not allowed', 405)

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-approve', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  let organizationId: string
  let userId: string
  try {
    const auth = await verifyUserAuth(req)
    organizationId = auth.organizationId
    userId = auth.userId
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 401
    return errorResponse('Unauthorized', status)
  }

  let body: ApproveInput
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!body.queue_item_id || !body.action) {
    return errorResponse('Missing required fields: queue_item_id, action', 400)
  }
  if (body.action !== 'approved' && body.action !== 'rejected') {
    return errorResponse("action must be 'approved' or 'rejected'", 400)
  }

  // ── Charger l'item (scope org) ───────────────────────────
  const { data: item, error: itemError } = await supabase
    .from('playbook_approval_queue')
    .select('*')
    .eq('id', body.queue_item_id)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (itemError) return errorResponse('Database error', 500)
  if (!item) return errorResponse('Queue item not found', 404)

  const queueItem = item as QueueItem

  // ── Verifier statut ──────────────────────────────────────
  if (queueItem.status !== 'pending') {
    return errorResponse(`Item deja traite (statut: ${queueItem.status})`, 409)
  }

  // ── Verifier expiry ──────────────────────────────────────
  if (new Date(queueItem.expires_at) < new Date()) {
    await supabase
      .from('playbook_approval_queue')
      .update({ status: 'expired', updated_at: new Date().toISOString() })
      .eq('id', queueItem.id)

    return errorResponse('Queue item expire (delai de 48h depasse)', 410)
  }

  // ── Mettre a jour le statut ──────────────────────────────
  await supabase
    .from('playbook_approval_queue')
    .update({
      status: body.action,
      reviewed_by: userId,
      reviewed_at: new Date().toISOString(),
      review_comment: body.comment ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', queueItem.id)

  if (body.action === 'rejected') {
    return jsonResponse({ success: true, action: 'rejected' })
  }

  // ── Approbation : appeler le connecteur ──────────────────
  const { data: dest, error: destError } = await supabase
    .from('playbook_destinations')
    .select('api_key_vault_key, api_endpoint, template_id, message_template, name')
    .eq('id', queueItem.destination_id)
    .maybeSingle()

  if (destError || !dest) {
    return errorResponse('Destination not found', 404)
  }

  const destination = dest as DestinationRow

  // Recuperer la cle Stripe de l'org
  const { data: orgRow } = await supabase
    .from('organizations')
    .select('stripe_api_key')
    .eq('id', organizationId)
    .maybeSingle()

  const stripeApiKey = orgRow?.stripe_api_key ?? Deno.env.get('STRIPE_SECRET_KEY') ?? ''

  // TRANSIT PII — email en memoire uniquement, jamais persiste
  const emailTransit = stripeApiKey
    ? await getCustomerEmailTransit(queueItem.stripe_customer_id, stripeApiKey)
    : null

  const config: ConnectorConfig = {
    api_key: destination.api_key_vault_key ?? '',
    api_endpoint: destination.api_endpoint ?? undefined,
    template_id: destination.template_id ?? undefined,
    message_template: destination.message_template ?? undefined,
  }

  const mrrCents = queueItem.mrr_cents_at_trigger ?? 0

  const connectorPayload: ConnectorPayload = {
    stripe_customer_id: queueItem.stripe_customer_id,
    segment: queueItem.segment_at_trigger ?? 'unknown',
    segment_previous: queueItem.segment_previous ?? undefined,
    health_score: queueItem.health_score_at_trigger ?? 50,
    churn_risk_score: queueItem.churn_risk_at_trigger ?? 50,
    expansion_score: queueItem.expansion_score_at_trigger ?? 0,
    mrr_cents: mrrCents,
    mrr_eur: Math.round(mrrCents) / 100,
    organization_id: organizationId,
    trigger_reason: queueItem.trigger_reason,
    // Transit PII — jamais logue ni persiste
    customer_email_transit: emailTransit ?? '',
  }

  let connectorResult: ConnectorResult
  try {
    connectorResult = await runConnector(queueItem.connector, connectorPayload, config)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    connectorResult = { success: false, error_message: truncate(msg) }
  }

  // Logger dans playbook_execution_logs — SANS email
  await supabase.from('playbook_execution_logs').insert({
    organization_id: organizationId,
    destination_id: queueItem.destination_id,
    account_id: queueItem.account_id,
    stripe_customer_id: queueItem.stripe_customer_id,
    connector: queueItem.connector,
    trigger_reason: queueItem.trigger_reason,
    segment_at_trigger: queueItem.segment_at_trigger,
    churn_risk_at_trigger: queueItem.churn_risk_at_trigger,
    mrr_cents_at_trigger: mrrCents,
    success: connectorResult.success,
    http_status: connectorResult.http_status ?? null,
    error_message: connectorResult.error_message ?? null,
    connector_response: connectorResult.connector_response ?? null,
    executed_at: new Date().toISOString(),
  })

  // DLQ si echec connecteur — l'approbation reste committee
  if (!connectorResult.success) {
    await writeToDLQ(supabase, {
      organization_id: organizationId,
      provider: 'outbound',
      event_type: `playbook_approve.${queueItem.connector}.${queueItem.trigger_reason}`,
      payload: {
        queue_item_id: queueItem.id,
        destination_id: queueItem.destination_id,
        stripe_customer_id: queueItem.stripe_customer_id,
      },
      error_message: connectorResult.error_message ?? 'unknown error',
    })
  }

  // Mettre a jour last_triggered_at si succes
  if (connectorResult.success) {
    await supabase
      .from('playbook_destinations')
      .update({ last_triggered_at: new Date().toISOString() })
      .eq('id', queueItem.destination_id)
      .eq('organization_id', organizationId)
  }

  return jsonResponse({
    success: connectorResult.success,
    action: 'approved',
    connector_result: {
      http_status: connectorResult.http_status ?? null,
      connector_response: connectorResult.connector_response ?? null,
      error_message: connectorResult.error_message ?? null,
    },
  })
})
