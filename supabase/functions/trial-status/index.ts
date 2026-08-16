// ============================================================
// Edge Function : trial-status
// Statut de trial de l'org courante — contrat frontend déjà en place
// (src/lib/types/trial.ts::TrialStatus, useTrialStatus, TrialBanner)
// mais jusqu'ici sans backend : cet endpoint n'existait pas.
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
// GET /trial-status
//   Auth : Bearer token utilisateur (JWT ES256)
//   Response 200 : {
//     data: {
//       plan_type: 'free'|'growth'|'scale'|'enterprise',
//       trial_ends_at: string | null,
//       trial_days_remaining: number,
//       is_trial_active: boolean,
//       is_trial_expired: boolean,
//     }
//   }
//
// Volontairement PAS trial-gated (assertTrialActive n'est jamais appelé
// ici) — un compte en trial expiré doit pouvoir lire son propre statut,
// sans quoi il n'y aurait aucun moyen de savoir pourquoi les autres
// endpoints renvoient 402.
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { getTier } from '../_shared/subscription-tiers.ts'
import { computeTrialStatus } from '../_shared/trial-status.ts'
import { withSentry } from '../_shared/sentry.ts'

Deno.serve(withSentry('trial-status', async (req: Request): Promise<Response> => {
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
    console.error(JSON.stringify({ level: 'error', function_name: 'trial-status', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const { data: org } = await supabase
    .from('organizations')
    .select('plan_type, trial_ends_at')
    .eq('id', auth.organizationId)
    .maybeSingle()

  const tier = getTier(org?.plan_type ?? null)
  const status = computeTrialStatus(tier.key, org?.trial_ends_at ?? null, Date.now())

  return jsonResponse({ data: status })
}))
