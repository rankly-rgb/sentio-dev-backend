// ============================================================
// Edge Function : test-webhook
// Envoie un webhook de test au endpoint configuré
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { computeHmacSignature } from '../_shared/webhook-dispatcher.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  // Auth
  let auth
  try {
    auth = await verifyUserAuth(req)
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.message, err.status)
    return errorResponse('Authentication failed', 401)
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch {
    return errorResponse('Server configuration error', 500)
  }

  const orgId = auth.organizationId

  // Fetch webhook config
  const { data: config, error: cfgError } = await supabase
    .from('webhook_configs')
    .select('endpoint_url, webhook_secret')
    .eq('organization_id', orgId)
    .eq('provider', 'webhook')
    .maybeSingle()

  if (cfgError || !config || !config.endpoint_url) {
    return errorResponse('Aucune configuration webhook trouvée', 404)
  }

  // Build test payload
  const testPayload = {
    event: 'test' as const,
    test: true,
    triggered_at: new Date().toISOString(),
    organization_id: orgId,
    account: {
      account_id: '00000000-0000-0000-0000-000000000000',
      stripe_customer_id: 'cus_TEST_sentio_demo',
    },
    signals: {
      health_score: 28,
      churn_risk_score: 84,
      expansion_score: 12,
      mrr_cents: 49900,
      trigger_reason: 'Test de connexion Sentio AI',
    },
  }

  const payloadStr = JSON.stringify(testPayload)
  const signature = await computeHmacSignature(payloadStr, config.webhook_secret)
  const timestamp = Math.floor(Date.now() / 1000).toString()

  const startTime = Date.now()
  let statusCode = 0
  let success = false
  let errorMessage: string | undefined

  try {
    const resp = await fetchWithTimeout(
      config.endpoint_url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentio-Event': 'test',
          'X-Sentio-Signature': signature,
          'X-Sentio-Timestamp': timestamp,
          'X-Sentio-Version': '1',
        },
        body: payloadStr,
      },
      10_000,
    )
    statusCode = resp.status
    success = resp.ok
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err)
  }

  const latencyMs = Date.now() - startTime

  return jsonResponse({
    success,
    status_code: statusCode,
    latency_ms: latencyMs,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  })
})
