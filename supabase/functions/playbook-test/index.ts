/*
 * PLAYBOOK TEST
 *
 * Rôle : Permet de tester une playbook_destination depuis l'UI
 *        sans attendre un vrai signal de risque.
 *
 * Auth : Bearer token (JWT ES256)
 *
 * Input POST JSON :
 *   {
 *     destination_id  : string (UUID) — requis
 *   }
 *
 * Comportement :
 *   1. Vérifie que la destination appartient à l'org de l'utilisateur
 *   2. Récupère l'email de l'admin depuis profiles_ (transit test)
 *   3. Utilise un account de test fictif (cus_TEST_SENTIO)
 *   4. Appelle le connecteur avec trigger_reason = 'manual'
 *   5. Log dans playbook_execution_logs avec trigger_reason = 'manual'
 *
 * Output : { success: boolean, http_status: number | null, response: string }
 * Erreurs : 400 si payload invalide, 404 si destination inconnue, 500 si erreur DB
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth } from '../_shared/auth.ts'
import { callBrevo } from '../_shared/connectors/brevo.ts'
import { callLemlist } from '../_shared/connectors/lemlist.ts'
import { callActiveCampaign } from '../_shared/connectors/activecampaign.ts'
import { callMailchimp } from '../_shared/connectors/mailchimp.ts'
import { callHubspot } from '../_shared/connectors/hubspot.ts'
import { callSlack } from '../_shared/connectors/slack.ts'
import { callCustom } from '../_shared/connectors/custom.ts'
import type { ConnectorConfig, ConnectorPayload, ConnectorResult } from '../_shared/connectors/types.ts'
import { withSentry } from '../_shared/sentry.ts'

const TEST_STRIPE_CUSTOMER_ID = 'cus_TEST_SENTIO'

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

Deno.serve(withSentry('playbook-test', async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-test', message: msg }))
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

  let body: { destination_id?: string }
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  const { destination_id } = body
  if (!destination_id) {
    return errorResponse('Missing required field: destination_id', 400)
  }

  // Vérifier que la destination appartient à l'org
  const { data: dest, error: destError } = await supabase
    .from('playbook_destinations')
    .select('*')
    .eq('id', destination_id)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (destError) return errorResponse('Database error', 500)
  if (!dest) return errorResponse('Destination not found', 404)

  // Récupérer l'email de l'admin (transit test — pas un email client)
  const { data: profile } = await supabase
    .from('profiles_')
    .select('email')
    .eq('auth_user_id', userId)
    .maybeSingle()

  // Transit test : email de l'utilisateur Sentio, jamais d'un customer
  const testEmailTransit = profile?.email ?? 'test@sentio-test.internal'

  // Account fictif pour le test
  const testPayload: ConnectorPayload = {
    stripe_customer_id: TEST_STRIPE_CUSTOMER_ID,
    segment: 'en_danger_critique',
    segment_previous: 'a_risque_leger',
    health_score: 22,
    churn_risk_score: 85,
    expansion_score: 8,
    mrr_cents: 19900,
    mrr_eur: 199,
    organization_id: organizationId,
    trigger_reason: 'manual',
    // Transit test : email Sentio admin, PAS un email customer
    customer_email_transit: testEmailTransit,
  }

  const config: ConnectorConfig = {
    api_key: dest.api_key_vault_key ?? '',
    api_endpoint: dest.api_endpoint ?? undefined,
    template_id: dest.template_id ?? undefined,
    message_template: dest.message_template
      ? `[TEST SENTIO] ${dest.message_template}`
      : undefined,
  }

  const result = await runConnector(dest.connector, testPayload, config)

  // Logger dans playbook_execution_logs (sans email)
  // Pas de account_id réel pour un test fictif — on cherche un compte existant
  const { data: anyAccount } = await supabase
    .from('accounts')
    .select('id')
    .eq('organization_id', organizationId)
    .limit(1)
    .maybeSingle()

  if (anyAccount?.id) {
    await supabase.from('playbook_execution_logs').insert({
      organization_id: organizationId,
      destination_id: dest.id,
      account_id: anyAccount.id,
      stripe_customer_id: TEST_STRIPE_CUSTOMER_ID,
      connector: dest.connector,
      trigger_reason: 'manual',
      segment_at_trigger: 'en_danger_critique',
      churn_risk_at_trigger: 85,
      mrr_cents_at_trigger: 19900,
      success: result.success,
      http_status: result.http_status ?? null,
      error_message: result.error_message ?? null,
      connector_response: result.connector_response ?? null,
      executed_at: new Date().toISOString(),
    })
  }

  return jsonResponse({
    success: result.success,
    http_status: result.http_status ?? null,
    response: result.connector_response ?? result.error_message ?? '',
  })
}))
