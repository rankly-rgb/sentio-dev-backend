// ============================================================
// Edge Function : get-accounts-summary
// GET /get-accounts-summary?mode=count|risk
//
// Révélation progressive des données (principe Eyal/Hooked) :
//   mode=count → premier écran : "X comptes détectés"
//   mode=risk  → deuxième écran (après 2s frontend) : comptes en danger
//
// Zero-PII : company_name est un nom de société B2B, pas une personne.
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { withSentry } from '../_shared/sentry.ts'

Deno.serve(withSentry('get-accounts-summary', async (req: Request): Promise<Response> => {
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
    console.error(JSON.stringify({ level: 'error', function_name: 'get-accounts-summary', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const orgId = auth.organizationId
  const url = new URL(req.url)
  const mode = url.searchParams.get('mode') ?? 'count'

  if (mode !== 'count' && mode !== 'risk') {
    return errorResponse("mode must be 'count' or 'risk'", 400)
  }

  // ── mode=count : premier écran de révélation ──────────────
  if (mode === 'count') {
    const [totalRes, demoRes] = await Promise.all([
      supabase
        .from('accounts')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId),
      supabase
        .from('accounts')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .eq('is_demo', true),
    ])

    const total = totalRes.count ?? 0
    const demoCount = demoRes.count ?? 0

    return jsonResponse({
      total_accounts: total,
      is_demo: total > 0 && total === demoCount,
    })
  }

  // ── mode=risk : deuxième écran (après pause frontend 2s) ──

  // Lire les seuils personnalisés de l'org (avec fallback aux valeurs par défaut)
  const { data: prefs } = await supabase
    .from('org_preferences')
    .select('danger_threshold, at_risk_threshold')
    .eq('organization_id', orgId)
    .maybeSingle()

  const dangerThreshold = prefs?.danger_threshold ?? 40
  const atRiskThreshold = prefs?.at_risk_threshold ?? 60

  // Récupérer uniquement les comptes actifs (mrr_cents > 0) — les comptes churned
  // ne doivent pas gonfler le compteur "accounts_at_risk" du dashboard.
  const { data: accounts, error: accErr } = await supabase
    .from('accounts')
    .select('id, company_name, mrr_cents, is_demo')
    .eq('organization_id', orgId)
    .gt('mrr_cents', 0)

  if (accErr) {
    console.error(JSON.stringify({ level: 'error', function_name: 'get-accounts-summary', message: accErr.message }))
    return errorResponse('Failed to read accounts', 500)
  }

  if (!accounts?.length) {
    return jsonResponse({ at_risk_count: 0, danger_count: 0, past_due_count: 0, top_danger_accounts: [] })
  }

  // Récupérer les derniers scores — 1 query, déduplication en mémoire
  const accountIds = accounts.map(a => a.id)
  const { data: scores, error: scoreErr } = await supabase
    .from('score_history')
    .select('account_id, health_score, churn_risk_score, segment, snapshot_date')
    .eq('organization_id', orgId)
    .in('account_id', accountIds)
    .order('snapshot_date', { ascending: false })
    .limit(accountIds.length * 3) // au plus 3 snapshots par compte

  if (scoreErr) {
    console.error(JSON.stringify({ level: 'error', function_name: 'get-accounts-summary', message: scoreErr.message }))
  }

  // Construire une Map account_id → score le plus récent
  const latestScore = new Map<string, { health_score: number; churn_risk_score: number; segment: string }>()
  for (const row of scores ?? []) {
    if (!latestScore.has(row.account_id) && row.health_score !== null) {
      latestScore.set(row.account_id, {
        health_score: row.health_score,
        churn_risk_score: row.churn_risk_score ?? 0,
        segment: row.segment ?? '',
      })
    }
  }

  // Récupérer les factures impayées pour past_due_count
  const { count: pastDueCount } = await supabase
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .in('status', ['open', 'uncollectible'])
    .lt('due_date', new Date().toISOString())

  // Classifier les comptes
  let atRiskCount = 0
  let dangerCount = 0
  const dangerAccounts: Array<{
    account_id: string
    company_name: string
    health_score: number
    mrr_cents: number
    segment: string
    is_demo: boolean
  }> = []

  for (const acc of accounts) {
    const score = latestScore.get(acc.id)
    if (!score) continue
    const h = score.health_score

    if (h < dangerThreshold) {
      dangerCount++
      dangerAccounts.push({
        account_id: acc.id,
        company_name: acc.company_name,
        health_score: h,
        mrr_cents: acc.mrr_cents ?? 0,
        segment: score.segment,
        is_demo: acc.is_demo ?? false,
      })
    } else if (h < atRiskThreshold) {
      atRiskCount++
    }
  }

  // Trier par health_score ASC (les plus critiques en premier) et limiter à 5
  dangerAccounts.sort((a, b) => a.health_score - b.health_score)
  const topDanger = dangerAccounts.slice(0, 5)

  return jsonResponse({
    at_risk_count: atRiskCount,
    danger_count: dangerCount,
    past_due_count: pastDueCount ?? 0,
    top_danger_accounts: topDanger,
  })
}))
