// ============================================================
// Edge Function : onboarding-status
// Expose l'état d'onboarding de l'organisation courante.
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// GET /onboarding-status
//   Response 200 :
//     {
//       data: {
//         stripe_connected: boolean,       // au moins 1 compte avec sync Stripe réussi
//         hubspot_connected: boolean,      // au moins 1 compte avec sync HubSpot réussi
//         first_score_calculated: boolean, // au moins 1 score calculé pour l'org
//         aha_moment_ready: boolean,       // stripe_connected ET first_score_calculated
//         aha_moment_seen: boolean,        // aha_moment_seen_at IS NOT NULL
//         first_score_calculated_at: string | null,  // ISO timestamp
//         aha_moment_seen_at: string | null,         // ISO timestamp
//         accounts_count: number,          // nb de comptes importés
//         top_risk_account: {              // présent si aha_moment_ready et non encore vu
//           id: string,
//           stripe_customer_id: string,
//           display_name: string | null,
//           churn_risk_score: number,
//           health_score: number
//         } | null
//       }
//     }
//
// POST /onboarding-status/aha-seen
//   Marque le aha moment comme vu (met à jour aha_moment_seen_at).
//   Body : {} (vide)
//   Response 200 : { data: { aha_moment_seen_at: string } }
//
// Auth : JWT utilisateur vérifié dans le code (ES256 via verifyUserAuth)
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

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
    console.error(JSON.stringify({ level: 'error', function_name: 'onboarding-status', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const url = new URL(req.url)
  const orgId = auth.organizationId
  const path = url.pathname.split('/').pop()

  // POST .../aha-seen — marquer le aha moment comme vu
  if (req.method === 'POST' && path === 'aha-seen') {
    return handleAhaSeen(supabase, orgId)
  }

  if (req.method === 'GET') return handleGetStatus(supabase, orgId)

  return errorResponse('Method not allowed', 405)
})

// ── GET /onboarding-status ───────────────────────────────────

async function handleGetStatus(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
): Promise<Response> {
  // Parallel: org, stripe indicator, hubspot indicator, accounts count
  const [orgRes, stripeRes, hubspotRes, accountsCountRes] = await Promise.all([
    supabase.from('organizations')
      .select('first_score_calculated_at, aha_moment_seen_at')
      .eq('id', orgId)
      .maybeSingle(),
    // Stripe connecté = au moins 1 sync Stripe complété
    supabase.from('data_syncs')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('sync_source', 'stripe')
      .eq('sync_status', 'completed')
      .limit(1),
    // HubSpot connecté = au moins 1 sync HubSpot complété
    supabase.from('data_syncs')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('sync_source', 'hubspot')
      .eq('sync_status', 'completed')
      .limit(1),
    supabase.from('accounts')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId),
  ])

  if (orgRes.error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'onboarding-status', message: orgRes.error.message }))
    return errorResponse('Failed to fetch organization', 500)
  }

  const org = orgRes.data
  const stripeConnected = (stripeRes.count ?? 0) > 0
  const hubspotConnected = (hubspotRes.count ?? 0) > 0
  const accountsCount = accountsCountRes.count ?? 0

  // Déduire first_score_calculated depuis la colonne ou depuis score_history
  const firstScoreAt = org?.first_score_calculated_at ?? null
  let firstScoreCalculated = firstScoreAt !== null

  // Si pas encore marqué, vérifier score_history (rétrocompatibilité)
  if (!firstScoreCalculated && accountsCount > 0) {
    const { count: scoreCount } = await supabase
      .from('score_history')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .limit(1)
    firstScoreCalculated = (scoreCount ?? 0) > 0
  }

  const ahaMomentReady = stripeConnected && firstScoreCalculated
  const ahaMomentSeen = org?.aha_moment_seen_at !== null && org?.aha_moment_seen_at !== undefined

  // Compte le plus à risque (pour le aha moment)
  let topRiskAccount = null
  if (ahaMomentReady && !ahaMomentSeen) {
    const { data: riskAccount } = await supabase
      .from('accounts')
      .select('id, stripe_customer_id, display_name, churn_risk_score, health_score')
      .eq('organization_id', orgId)
      .not('churn_risk_score', 'is', null)
      .order('churn_risk_score', { ascending: false })
      .limit(1)
      .maybeSingle()
    topRiskAccount = riskAccount ?? null
  }

  return jsonResponse({
    data: {
      stripe_connected: stripeConnected,
      hubspot_connected: hubspotConnected,
      first_score_calculated: firstScoreCalculated,
      aha_moment_ready: ahaMomentReady,
      aha_moment_seen: ahaMomentSeen,
      first_score_calculated_at: firstScoreAt,
      aha_moment_seen_at: org?.aha_moment_seen_at ?? null,
      accounts_count: accountsCount,
      top_risk_account: topRiskAccount,
    },
  })
}

// ── POST /onboarding-status/aha-seen ────────────────────────

async function handleAhaSeen(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
): Promise<Response> {
  const now = new Date().toISOString()

  const { error } = await supabase
    .from('organizations')
    .update({ aha_moment_seen_at: now })
    .eq('id', orgId)
    .is('aha_moment_seen_at', null) // idempotent : ne ré-écrit pas si déjà vu

  if (error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'onboarding-status', message: error.message }))
    return errorResponse('Failed to mark aha moment as seen', 500)
  }

  // Relire la valeur réelle (peut être inchangée si déjà marqué)
  const { data: org } = await supabase
    .from('organizations')
    .select('aha_moment_seen_at')
    .eq('id', orgId)
    .maybeSingle()

  return jsonResponse({ data: { aha_moment_seen_at: org?.aha_moment_seen_at ?? now } })
}
