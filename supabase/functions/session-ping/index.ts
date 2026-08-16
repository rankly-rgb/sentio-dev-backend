// ============================================================
// Edge Function : session-ping
// Mise à jour de last_seen_at à chaque ouverture de session.
// Permet au frontend de savoir quels insights / variations de score
// sont "nouveaux" (apparus depuis la dernière visite).
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// POST /session-ping
//   Body : {} (vide, ou ignoré)
//   Response 200 :
//     {
//       data: {
//         last_seen_at: string,          // ISO timestamp précédent (avant cette session)
//         current_seen_at: string,       // ISO timestamp mis à jour maintenant
//         new_insights_count: number,    // nb d'insights actifs apparus depuis last_seen_at
//         new_score_changes_count: number // nb de comptes dont le score a bougé depuis last_seen_at
//       }
//     }
//
// Règle is_new :
//   - Insight : is_new = ai_insights.created_at > last_seen_at (avant ping)
//   - Score variation significative : |health_score_now - health_score_at_last_seen| >= 5 pts
//
// Note : La réponse expose les compteurs "nouveaux" calculés sur le
// last_seen_at AVANT la mise à jour, pour que le frontend puisse
// décider d'afficher des badges / animations avant le prochain ping.
//
// Auth : JWT utilisateur vérifié dans le code (ES256 via verifyUserAuth)
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { withSentry } from '../_shared/sentry.ts'

// Delta minimum de health_score pour compter comme "variation significative"
const SCORE_CHANGE_THRESHOLD = 5

Deno.serve(withSentry('session-ping', async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  let auth
  try {
    auth = await verifyUserAuth(req)
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.message, err.status)
    return errorResponse('Authentication failed', 401)
  }

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'session-ping', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const orgId = auth.organizationId
  const userId = auth.userId
  const now = new Date().toISOString()

  // 1. Lire last_seen_at AVANT la mise à jour
  const { data: profile, error: profileErr } = await supabase
    .from('profiles_')
    .select('last_seen_at')
    .eq('auth_user_id', userId)
    .maybeSingle()

  if (profileErr) {
    console.error(JSON.stringify({ level: 'error', function_name: 'session-ping', organization_id: orgId, message: profileErr.message }))
    return errorResponse('Failed to read session state', 500)
  }

  const previousLastSeen: string | null = profile?.last_seen_at ?? null

  // 2. Mettre à jour last_seen_at
  const { error: updateErr } = await supabase
    .from('profiles_')
    .update({ last_seen_at: now })
    .eq('auth_user_id', userId)

  if (updateErr) {
    console.error(JSON.stringify({ level: 'error', function_name: 'session-ping', organization_id: orgId, message: updateErr.message }))
    return errorResponse('Failed to update session', 500)
  }

  // 3. Si c'est la première visite, retourner 0 nouveautés
  if (!previousLastSeen) {
    return jsonResponse({
      data: {
        last_seen_at: null,
        current_seen_at: now,
        new_insights_count: 0,
        new_score_changes_count: 0,
      },
    })
  }

  // 4. Compter les insights apparus depuis last_seen_at (en parallèle avec les scores)
  const snapshotDate = previousLastSeen.split('T')[0]

  const [newInsightsRes, currentScoresRes, snapshotScoresRes] = await Promise.all([
    // Insights créés après la dernière visite
    supabase.from('ai_insights')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .gt('created_at', previousLastSeen),

    // Scores actuels
    supabase.from('accounts')
      .select('id, health_score')
      .eq('organization_id', orgId)
      .not('health_score', 'is', null)
      .limit(2000),

    // Scores au snapshot le plus proche de last_seen_at
    supabase.from('score_history')
      .select('account_id, health_score')
      .eq('organization_id', orgId)
      .eq('snapshot_date', snapshotDate)
      .limit(2000),
  ])

  // 5. Compter les variations significatives de score
  const snapshotByAccount = new Map(
    (snapshotScoresRes.data ?? []).map((s: { account_id: string; health_score: number | null }) => [s.account_id, s.health_score]),
  )

  let newScoreChangesCount = 0
  for (const account of (currentScoresRes.data ?? [])) {
    const snapshotScore = snapshotByAccount.get(account.id)
    if (snapshotScore === undefined || snapshotScore === null || account.health_score === null) continue
    if (Math.abs((account.health_score as number) - snapshotScore) >= SCORE_CHANGE_THRESHOLD) {
      newScoreChangesCount++
    }
  }

  return jsonResponse({
    data: {
      last_seen_at: previousLastSeen,
      current_seen_at: now,
      new_insights_count: newInsightsRes.count ?? 0,
      new_score_changes_count: newScoreChangesCount,
    },
  })
}))
