/*
 * PLAYBOOK EXECUTOR
 *
 * Rôle : Déclenche les actions configurées (email, slack, webhook)
 *        quand un account atteint un seuil de risque.
 *
 *        Récupère l'email du customer directement depuis l'API Stripe
 *        en transit (jamais persisté).
 *
 * Appelée par : calculate-scores (fire-and-forget)
 *               stripe-webhook (invoice.payment_failed)
 *               playbook-test (test manuel, trigger_reason='manual')
 *
 * Input POST JSON :
 *   {
 *     organization_id     : string (UUID) — requis
 *     stripe_customer_id  : string        — requis
 *     trigger_reason      : 'segment_change' | 'churn_threshold' |
 *                           'invoice_past_due' | 'manual'
 *     account_id          : string (UUID) — optionnel (lookup auto si absent)
 *     segment_current     : string        — optionnel (lookup auto si absent)
 *     segment_previous    : string        — optionnel
 *     health_score        : number        — optionnel (lookup auto si absent)
 *     churn_risk_score    : number        — optionnel (lookup auto si absent)
 *     expansion_score     : number        — optionnel (lookup auto si absent)
 *     mrr_cents           : number        — optionnel (lookup auto si absent)
 *   }
 *
 * Comportement :
 *   1. Récupérer les playbook_destinations actives de l'org
 *   2. Filtrer celles qui matchent trigger_reason + critères
 *   3. Lookup account depuis DB si données manquantes
 *   4. Pour chaque destination matchée :
 *        a. Récupérer stripe_api_key depuis organizations.stripe_api_key
 *        b. Récupérer customer_email DEPUIS STRIPE API (transit only)
 *        c. Appeler le connecteur approprié
 *        d. Logger dans playbook_execution_logs (sans email)
 *        e. Si échec définitif → webhook_dead_letter
 *   5. Mettre à jour last_triggered_at sur les destinations déclenchées
 *
 * Transit PII :
 *   L'email Stripe est récupéré en mémoire uniquement.
 *   Il n'est JAMAIS écrit dans aucune table, log, ou payload persisté.
 *   Durée de vie en mémoire : < 500ms par exécution.
 *
 * Output : { executed: number, failed: number, destinations: string[] }
 * Erreurs : 400 si payload invalide, 500 si erreur DB critique
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
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

interface ExecutorInput {
  organization_id: string
  stripe_customer_id: string
  trigger_reason: 'segment_change' | 'churn_threshold' | 'invoice_past_due' | 'manual'
  account_id?: string
  segment_current?: string
  segment_previous?: string
  health_score?: number
  churn_risk_score?: number
  expansion_score?: number
  mrr_cents?: number
}

interface PlaybookDestination {
  id: string
  organization_id: string
  name: string
  connector: string
  is_active: boolean
  require_approval: boolean
  trigger_segments: string[]
  trigger_churn_threshold: number | null
  trigger_on_invoice_past_due: boolean
  api_key_vault_key: string | null
  api_endpoint: string | null
  template_id: string | null
  message_template: string | null
}

interface AccountRow {
  id: string
  stripe_customer_id: string
  health_score: number | null
  churn_risk_score: number | null
  expansion_score: number | null
  mrr_cents: number | null
}

// ── Matching logique ─────────────────────────────────────────

export function matchesDestination(
  destination: PlaybookDestination,
  input: ExecutorInput,
): boolean {
  if (!destination.is_active) return false

  // Match par segment
  if (
    destination.trigger_segments.length > 0 &&
    input.segment_current !== undefined &&
    destination.trigger_segments.indexOf(input.segment_current) !== -1
  ) return true

  // Match par seuil churn
  if (
    destination.trigger_churn_threshold !== null &&
    input.churn_risk_score !== undefined &&
    input.churn_risk_score >= destination.trigger_churn_threshold
  ) return true

  // Match par invoice past_due
  if (
    destination.trigger_on_invoice_past_due &&
    input.trigger_reason === 'invoice_past_due'
  ) return true

  return false
}

// ── Récupération email en transit depuis Stripe ──────────────

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
    // email existe uniquement en mémoire — ne pas logger, ne pas stocker
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
    case 'brevo':        return callBrevo(payload, config)
    case 'lemlist':      return callLemlist(payload, config)
    case 'activecampaign': return callActiveCampaign(payload, config)
    case 'mailchimp':    return callMailchimp(payload, config)
    case 'hubspot':      return callHubspot(payload, config)
    case 'slack':        return callSlack(payload, config)
    case 'custom':       return callCustom(payload, config)
    default:
      return { success: false, error_message: `Connecteur inconnu : ${connector}` }
  }
}

// ── Entrypoint ───────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-executor', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  let input: ExecutorInput
  try {
    input = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!input.organization_id || !input.stripe_customer_id || !input.trigger_reason) {
    return errorResponse('Missing required fields: organization_id, stripe_customer_id, trigger_reason', 400)
  }

  const validTriggers = ['segment_change', 'churn_threshold', 'invoice_past_due', 'manual']
  if (validTriggers.indexOf(input.trigger_reason) === -1) {
    return errorResponse(`Invalid trigger_reason. Values: ${validTriggers.join(', ')}`, 400)
  }

  // ── Récupérer les destinations actives ───────────────────
  const { data: destinations, error: destError } = await supabase
    .from('playbook_destinations')
    .select('*')
    .eq('organization_id', input.organization_id)
    .eq('is_active', true)

  if (destError) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'playbook-executor',
      organization_id: input.organization_id,
      message: `destinations lookup failed: ${destError.message}`,
    }))
    return errorResponse('Database error', 500)
  }

  const matched = (destinations as PlaybookDestination[]).filter((d) =>
    matchesDestination(d, input)
  )

  if (matched.length === 0) {
    return jsonResponse({ executed: 0, queued: 0, failed: 0, destinations: [] })
  }

  // ── Bifurcation : immediate vs approval queue ────────────
  const immediateDestinations = matched.filter((d) => !d.require_approval)
  const queuedDestinations = matched.filter((d) => d.require_approval)

  // ── Lookup account si données manquantes ────────────────
  let accountRow: AccountRow | null = null
  if (
    input.account_id === undefined ||
    input.health_score === undefined ||
    input.churn_risk_score === undefined ||
    input.expansion_score === undefined ||
    input.mrr_cents === undefined
  ) {
    const { data } = await supabase
      .from('accounts')
      .select('id, stripe_customer_id, health_score, churn_risk_score, expansion_score, mrr_cents')
      .eq('organization_id', input.organization_id)
      .eq('stripe_customer_id', input.stripe_customer_id)
      .maybeSingle()
    accountRow = data ?? null
  }

  const accountId = input.account_id ?? accountRow?.id ?? ''
  const healthScore = input.health_score ?? accountRow?.health_score ?? 50
  const churnRisk = input.churn_risk_score ?? accountRow?.churn_risk_score ?? 50
  const expansionScore = input.expansion_score ?? accountRow?.expansion_score ?? 0
  const mrrCents = input.mrr_cents ?? accountRow?.mrr_cents ?? 0
  const segmentCurrent = input.segment_current ?? 'unknown'

  if (!accountId) {
    return errorResponse('Account not found for this stripe_customer_id', 404)
  }

  // ── Insérer les destinations en attente de validation ────
  let queued = 0
  if (queuedDestinations.length > 0) {
    const queueRows = queuedDestinations.map((dest) => ({
      organization_id: input.organization_id,
      destination_id: dest.id,
      account_id: accountId,
      stripe_customer_id: input.stripe_customer_id,
      connector: dest.connector,
      trigger_reason: input.trigger_reason,
      segment_at_trigger: segmentCurrent,
      segment_previous: input.segment_previous ?? null,
      churn_risk_at_trigger: churnRisk,
      health_score_at_trigger: healthScore,
      expansion_score_at_trigger: expansionScore,
      mrr_cents_at_trigger: mrrCents,
      expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    }))

    const { error: queueError } = await supabase
      .from('playbook_approval_queue')
      .insert(queueRows)

    if (queueError) {
      console.error(JSON.stringify({
        level: 'error',
        function_name: 'playbook-executor',
        organization_id: input.organization_id,
        message: `approval queue insert failed: ${queueError.message}`,
      }))
    } else {
      queued = queuedDestinations.length
    }
  }

  if (immediateDestinations.length === 0) {
    return jsonResponse({ executed: 0, queued, failed: 0, destinations: [] })
  }

  // ── Récupérer la clé Stripe de l'org ────────────────────
  const { data: orgRow } = await supabase
    .from('organizations')
    .select('stripe_api_key')
    .eq('id', input.organization_id)
    .maybeSingle()

  const stripeApiKey = orgRow?.stripe_api_key ?? Deno.env.get('STRIPE_SECRET_KEY') ?? ''

  // ── Récupérer l'email en transit ────────────────────────
  // TRANSIT PII — jamais persisté, durée de vie < 500ms
  const emailTransit = stripeApiKey
    ? await getCustomerEmailTransit(input.stripe_customer_id, stripeApiKey)
    : null

  // ── Exécuter les destinations immédiates en parallèle ────
  let executed = 0
  let failed = 0
  const triggeredNames: string[] = []

  const results = await Promise.allSettled(
    immediateDestinations.map(async (dest) => {
      const config: ConnectorConfig = {
        api_key: dest.api_key_vault_key ?? '',
        api_endpoint: dest.api_endpoint ?? undefined,
        template_id: dest.template_id ?? undefined,
        message_template: dest.message_template ?? undefined,
      }

      const connectorPayload: ConnectorPayload = {
        stripe_customer_id: input.stripe_customer_id,
        segment: segmentCurrent,
        segment_previous: input.segment_previous,
        health_score: healthScore,
        churn_risk_score: churnRisk,
        expansion_score: expansionScore,
        mrr_cents: mrrCents,
        mrr_eur: Math.round(mrrCents) / 100,
        organization_id: input.organization_id,
        trigger_reason: input.trigger_reason,
        // Transit PII — jamais loggé ni persisté
        customer_email_transit: emailTransit ?? '',
      }

      let result: ConnectorResult
      try {
        result = await runConnector(dest.connector, connectorPayload, config)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result = { success: false, error_message: truncate(msg) }
      }

      // Logger dans playbook_execution_logs — SANS email
      await supabase.from('playbook_execution_logs').insert({
        organization_id: input.organization_id,
        destination_id: dest.id,
        account_id: accountId,
        stripe_customer_id: input.stripe_customer_id,
        connector: dest.connector,
        trigger_reason: input.trigger_reason,
        segment_at_trigger: segmentCurrent,
        churn_risk_at_trigger: churnRisk,
        mrr_cents_at_trigger: mrrCents,
        success: result.success,
        http_status: result.http_status ?? null,
        error_message: result.error_message ?? null,
        connector_response: result.connector_response ?? null,
        executed_at: new Date().toISOString(),
      })

      // DLQ si échec définitif
      if (!result.success) {
        await writeToDLQ(supabase, {
          organization_id: input.organization_id,
          provider: 'outbound',
          event_type: `playbook_executor.${dest.connector}.${input.trigger_reason}`,
          payload: {
            destination_id: dest.id,
            stripe_customer_id: input.stripe_customer_id,
            trigger_reason: input.trigger_reason,
          },
          error_message: result.error_message ?? 'unknown error',
        })
      }

      return { dest, result }
    }),
  )

  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value.result.success) {
        executed++
        triggeredNames.push(r.value.dest.name)
      } else {
        failed++
      }
    } else {
      failed++
    }
  }

  // Mettre à jour last_triggered_at sur les destinations exécutées avec succès
  const successIds = results
    .filter((r) => r.status === 'fulfilled' && r.value.result.success)
    .map((r) => (r as PromiseFulfilledResult<{ dest: PlaybookDestination; result: ConnectorResult }>).value.dest.id)

  if (successIds.length > 0) {
    await supabase
      .from('playbook_destinations')
      .update({ last_triggered_at: new Date().toISOString() })
      .in('id', successIds)
      .eq('organization_id', input.organization_id)
  }

  return jsonResponse({ executed, queued, failed, destinations: triggeredNames })
})
