// ============================================================
// Edge Function : get-today-status
// Statut global du portefeuille pour la page "Aujourd'hui".
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// GET /get-today-status
//   Auth : Bearer token (JWT Supabase)
//
//   Response 200 :
//     {
//       data: {
//         status: 'critical' | 'at_risk' | 'stable',
//         critical_count: number,
//         top_urgent_account: {
//           id: string,
//           name: string | null,
//           mrr: number,           // en centimes
//           risk_score: number,
//           top_insight: string | null
//         } | null
//       }
//     }
//
// Règles de statut :
//   1. critical_count > 0 (insights ai_insights actifs, priority='critical') → 'critical'
//   2. sinon, part des comptes scorés avec churn_risk_score > 70 dépasse 30 % → 'at_risk'
//   3. sinon → 'stable'
//
// top_urgent_account = compte avec churn_risk_score > 70 au MRR le plus élevé.
//
// Auth : JWT utilisateur vérifié dans le code (ES256 via verifyUserAuth)
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'

const AT_RISK_CHURN_THRESHOLD = 70
const AT_RISK_RATIO_THRESHOLD = 0.3

interface AccountRow {
  id: string
  display_name: string | null
  mrr_cents: number | null
  churn_risk_score: number | null
}

interface InsightRow {
  title: string
  priority: string
}

export type TodayStatus = 'critical' | 'at_risk' | 'stable'

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

export function determineTodayStatus(
  criticalInsightCount: number,
  atRiskAccountCount: number,
  scoredAccountCount: number,
): TodayStatus {
  if (criticalInsightCount > 0) return 'critical'
  if (scoredAccountCount > 0 && atRiskAccountCount / scoredAccountCount > AT_RISK_RATIO_THRESHOLD) {
    return 'at_risk'
  }
  return 'stable'
}

export function selectTopUrgentAccount(accounts: AccountRow[]): AccountRow | null {
  const atRisk = accounts.filter((a) => (a.churn_risk_score ?? 0) > AT_RISK_CHURN_THRESHOLD)
  if (atRisk.length === 0) return null
  return atRisk.reduce((top, a) => ((a.mrr_cents ?? 0) > (top.mrr_cents ?? 0) ? a : top))
}

export function selectTopInsightTitle(insights: InsightRow[]): string | null {
  if (insights.length === 0) return null
  const sorted = [...insights].sort(
    (a, b) => (PRIORITY_RANK[a.priority] ?? 4) - (PRIORITY_RANK[b.priority] ?? 4),
  )
  return sorted[0].title
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
    console.error(JSON.stringify({ level: 'error', function_name: 'get-today-status', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const orgId = auth.organizationId

  const { count: criticalInsightCount, error: criticalError } = await supabase
    .from('ai_insights')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .eq('status', 'active')
    .eq('priority', 'critical')

  if (criticalError) {
    console.error(JSON.stringify({ level: 'error', function_name: 'get-today-status', message: criticalError.message }))
    return errorResponse('Failed to fetch insights', 500)
  }

  const { data: accounts, error: accountsError } = await supabase
    .from('accounts')
    .select('id, display_name, mrr_cents, churn_risk_score')
    .eq('organization_id', orgId)
    .not('churn_risk_score', 'is', null)
    .limit(500)

  if (accountsError) {
    console.error(JSON.stringify({ level: 'error', function_name: 'get-today-status', message: accountsError.message }))
    return errorResponse('Failed to fetch accounts', 500)
  }

  const typedAccounts = (accounts ?? []) as AccountRow[]
  const atRiskAccounts = typedAccounts.filter((a) => (a.churn_risk_score ?? 0) > AT_RISK_CHURN_THRESHOLD)

  const status = determineTodayStatus(criticalInsightCount ?? 0, atRiskAccounts.length, typedAccounts.length)

  const topAccount = selectTopUrgentAccount(typedAccounts)

  if (!topAccount) {
    return jsonResponse({
      data: {
        status,
        critical_count: criticalInsightCount ?? 0,
        top_urgent_account: null,
      },
    })
  }

  const { data: topInsights, error: topInsightsError } = await supabase
    .from('ai_insights')
    .select('title, priority')
    .eq('organization_id', orgId)
    .eq('account_id', topAccount.id)
    .eq('status', 'active')

  if (topInsightsError) {
    console.error(JSON.stringify({ level: 'error', function_name: 'get-today-status', message: topInsightsError.message }))
    return errorResponse('Failed to fetch account insights', 500)
  }

  return jsonResponse({
    data: {
      status,
      critical_count: criticalInsightCount ?? 0,
      top_urgent_account: {
        id: topAccount.id,
        name: topAccount.display_name,
        mrr: topAccount.mrr_cents ?? 0,
        risk_score: topAccount.churn_risk_score ?? 0,
        top_insight: selectTopInsightTitle((topInsights ?? []) as InsightRow[]),
      },
    },
  })
})
