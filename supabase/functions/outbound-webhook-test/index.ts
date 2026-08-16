/*
 * OUTBOUND WEBHOOK TEST
 *
 * Rôle : Permet de tester une destination outbound depuis l'UI sans attendre
 *        un vrai événement. Envoie un payload de test avec des données fictives.
 *
 * Input (POST JSON) :
 *   {
 *     destination_id: string (UUID)
 *     organization_id: string (UUID)
 *   }
 *
 * Comportement :
 *   1. Vérifie que la destination appartient à l'org
 *   2. Construit un payload de test (données fictives, Zero-PII)
 *   3. Envoie le payload vers destination_url
 *   4. Retourne le résultat
 *
 * Output : { success: boolean, status: number | null, response: string }
 * Erreurs : 400 si payload invalide, 404 si destination inconnue, 500 si erreur DB
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth } from '../_shared/auth.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'
import { withSentry } from '../_shared/sentry.ts'

const TEST_TIMEOUT_MS = 10000

Deno.serve(withSentry('outbound-webhook-test', async (req: Request): Promise<Response> => {
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
    console.error(JSON.stringify({ level: 'error', function_name: 'outbound-webhook-test', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  // Auth JWT (ES256)
  let organizationId: string
  try {
    const auth = await verifyUserAuth(req)
    organizationId = auth.organizationId
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 401
    return errorResponse('Unauthorized', status)
  }

  let body: { destination_id?: string; organization_id?: string }
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  const { destination_id } = body

  if (!destination_id) {
    return errorResponse('Missing required field: destination_id', 400)
  }

  // Vérifier que la destination appartient à l'org de l'utilisateur
  const { data: dest, error: destError } = await supabase
    .from('outbound_webhook_destinations')
    .select('id, organization_id, destination_url, secret_header_name, secret_header_value, name')
    .eq('id', destination_id)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (destError) {
    return errorResponse('Database error', 500)
  }

  if (!dest) {
    return errorResponse('Destination not found', 404)
  }

  // Payload de test (données fictives, Zero-PII)
  const testPayload = {
    source: 'sentio_ai',
    event: 'account_risk_detected',
    account: {
      stripe_customer_id: 'cus_TEST123',
      segment: 'en_danger_critique',
      segment_previous: 'a_risque_leger',
      health_score: 28,
      churn_risk_score: 75,
      expansion_score: 12,
      mrr_cents: 49900,
      mrr_eur: 499,
    },
    triggered_at: new Date().toISOString(),
    organization_id: organizationId,
    _test: true,
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Sentio-AI/1.0',
  }

  if (dest.secret_header_name && dest.secret_header_value) {
    headers[dest.secret_header_name] = dest.secret_header_value
  }

  let success = false
  let status: number | null = null
  let response = ''

  try {
    const res = await fetchWithTimeout(
      dest.destination_url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(testPayload),
      },
      TEST_TIMEOUT_MS,
    )

    status = res.status
    const rawBody = await res.text().catch(() => '')
    response = rawBody.slice(0, 500)
    success = res.status >= 200 && res.status < 300
  } catch (err) {
    response = err instanceof Error ? err.message : String(err)
  }

  return jsonResponse({ success, status, response })
}))
