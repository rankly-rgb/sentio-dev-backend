// ============================================================
// Edge Function : get-top-churn-risks
// GET /get-top-churn-risks
//
// Retourne les 3 comptes avec le churn_risk_score le plus élevé.
// stripe_customer_id JAMAIS en clair — masqué via maskStripeId().
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
// GET /get-top-churn-risks
//   Auth : Bearer token (JWT ES256)
//   Response 200 :
//     {
//       accounts: [
//         {
//           masked_id: "cus_***abc",
//           health_score: number,
//           churn_risk_score: number,
//           plan_tier: string | null,
//           mrr_cents: number
//         }
//       ]
//     }
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, jsonResponse, errorResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'

export function maskStripeId(id: string): string {
  if (!id || id.length < 3) return 'cus_***'
  return 'cus_***' + id.slice(-3)
}

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'GET') return errorResponse('Method not allowed', 405)

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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'get-top-churn-risks', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const orgId = auth.organizationId

  const { data, error } = await supabase
    .from('accounts')
    .select('stripe_customer_id, health_score, churn_risk_score, plan_tier, mrr_cents')
    .eq('organization_id', orgId)
    .not('churn_risk_score', 'is', null)
    .order('churn_risk_score', { ascending: false })
    .limit(3)

  if (error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'get-top-churn-risks', message: error.message }))
    return errorResponse('Failed to fetch accounts', 500)
  }

  const accounts = (data ?? []).map((acc) => ({
    masked_id: maskStripeId(acc.stripe_customer_id ?? ''),
    health_score: acc.health_score ?? 0,
    churn_risk_score: acc.churn_risk_score ?? 0,
    plan_tier: acc.plan_tier ?? null,
    mrr_cents: acc.mrr_cents ?? 0,
  }))

  return jsonResponse({ accounts })
})
