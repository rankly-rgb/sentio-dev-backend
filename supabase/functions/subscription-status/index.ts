// ============================================================
// Edge Function : subscription-status
// Chantier C — statut d'abonnement Sentio de l'org : tier courant,
// nombre de comptes trackés vs plafond du tier, catalogue complet des
// tiers (pour l'écran pricing/upgrade).
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
// GET /subscription-status
//   Auth : Bearer token utilisateur (JWT ES256)
//   Response 200 : {
//     data: {
//       current_tier: 'free'|'growth'|'scale'|'enterprise',
//       accounts_count: number,
//       max_accounts: number | null,
//       is_over_limit: boolean,
//       tiers: SubscriptionTier[]
//     }
//   }
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { SUBSCRIPTION_TIERS, getTier, isOverAccountLimit } from '../_shared/subscription-tiers.ts'
import { withSentry } from '../_shared/sentry.ts'

Deno.serve(withSentry('subscription-status', async (req: Request): Promise<Response> => {
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
    console.error(JSON.stringify({ level: 'error', function_name: 'subscription-status', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const [{ data: org }, { count: accountsCount }] = await Promise.all([
    supabase
      .from('organizations')
      .select('plan_type')
      .eq('id', auth.organizationId)
      .maybeSingle(),
    supabase
      .from('accounts')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', auth.organizationId),
  ])

  const tier = getTier(org?.plan_type ?? null)
  const accountsTotal = accountsCount ?? 0

  return jsonResponse({
    data: {
      current_tier: tier.key,
      accounts_count: accountsTotal,
      max_accounts: tier.max_accounts,
      is_over_limit: isOverAccountLimit(accountsTotal, tier),
      tiers: SUBSCRIPTION_TIERS,
    },
  })
}))
