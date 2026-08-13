// ============================================================
// Edge Function : get-today-actions
// Liste priorisée d'actions pour la page "Today" — source de vérité unique
// (C2.4a) combinant playbooks actifs matchant un compte ET insights actifs,
// remplace le calcul 100% client-side de src/lib/types/today-actions.ts
// (frontend) qui ignorait totalement les insights.
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// GET /get-today-actions
//   Auth : Bearer token (JWT Supabase)
//
//   Response 200 :
//     {
//       data: {
//         status: 'critical' | 'attention_needed' | 'stable',
//         total: number,
//         by_priority: { P0: number, P1: number, P2: number },
//         by_category: Record<string, number>,
//         mrr_at_risk_cents: number,
//         actions: TodayAction[]   // voir _shared/today-actions-helpers.ts
//       }
//     }
//
// Règle non négociable (C2.4a) : `status` ne peut jamais être 'stable' si un
// insight critique actif existe, et `total` ne peut jamais être 0 dans ce
// cas — voir determinePortfolioStatus. C'est la correction directe de la
// contradiction trouvée par l'audit ("portfolio stable" + "0 priority
// actions" + "206 critical insights" affichés simultanément).
//
// Comptes churnés (D1) exclus de la sélection — un compte parti ne génère
// pas d'action prioritaire, playbooks et insights actifs sur ce compte
// n'ont plus rien à "sauver".
//
// Auth : JWT utilisateur vérifié dans le code (ES256 via verifyUserAuth)
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError, assertTrialActive } from '../_shared/auth.ts'
import {
  computeTodayActions,
  buildTodayActionsSummary,
  determinePortfolioStatus,
  type TodayAccountInput,
  type TodayPlaybookInput,
  type TodayInsightInput,
} from '../_shared/today-actions-helpers.ts'
import type { ConditionGroup } from '../_shared/playbook-engine.ts'

const ACCOUNTS_LIMIT = 5000
const PLAYBOOKS_LIMIT = 500
const INSIGHTS_LIMIT = 10000

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

  let supabase: SupabaseClient
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'get-today-actions', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  try {
    await assertTrialActive(supabase, auth.organizationId)
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.message, err.status)
    throw err
  }

  const orgId = auth.organizationId

  const [accountsRes, playbooksRes, insightsRes, segmentsRes] = await Promise.all([
    // D1 : exclut les comptes churnés — .or() plutôt que .neq() pour ne pas
    // droper par accident un compte pas encore scoré (churn_risk_band NULL).
    supabase
      .from('accounts')
      .select('id, stripe_customer_id, hubspot_company_id, display_name, health_score, churn_risk_score, expansion_score, mrr_cents, mrr_status, plan_tier, contract_end_date, billing_interval, created_at, is_delinquent')
      .eq('organization_id', orgId)
      .or('churn_risk_band.neq.churned,churn_risk_band.is.null')
      .limit(ACCOUNTS_LIMIT),
    supabase
      .from('playbooks')
      .select('id, title, priority, template_category, status, eligibility_criteria')
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .limit(PLAYBOOKS_LIMIT),
    supabase
      .from('ai_insights')
      .select('account_id, title, priority')
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .not('account_id', 'is', null)
      .limit(INSIGHTS_LIMIT),
    // primary_segment : même source/convention que accounts-api
    // (fetchPrimarySegments) — lu depuis segment_memberships, jamais
    // recalculé ici. 'nouveaux' exclu (non-exclusif, porté par created_at).
    supabase
      .from('segment_memberships')
      .select('account_id, account_segments!inner(segment_type)')
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .neq('account_segments.segment_type', 'nouveaux')
      .limit(ACCOUNTS_LIMIT),
  ])

  if (accountsRes.error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'get-today-actions', organization_id: orgId, message: accountsRes.error.message }))
    return errorResponse('Failed to fetch accounts', 500)
  }
  if (playbooksRes.error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'get-today-actions', organization_id: orgId, message: playbooksRes.error.message }))
    return errorResponse('Failed to fetch playbooks', 500)
  }
  if (insightsRes.error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'get-today-actions', organization_id: orgId, message: insightsRes.error.message }))
    return errorResponse('Failed to fetch insights', 500)
  }
  if (segmentsRes.error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'get-today-actions', organization_id: orgId, message: segmentsRes.error.message }))
    return errorResponse('Failed to fetch segments', 500)
  }

  const primarySegmentByAccountId = new Map<string, string>()
  for (const row of (segmentsRes.data ?? []) as { account_id: string; account_segments: { segment_type: string } | null }[]) {
    if (row.account_segments?.segment_type) primarySegmentByAccountId.set(row.account_id, row.account_segments.segment_type)
  }

  const accounts = ((accountsRes.data ?? []) as Omit<TodayAccountInput, 'primary_segment'>[]).map((a) => ({
    ...a,
    primary_segment: primarySegmentByAccountId.get(a.id) ?? null,
  }))
  const playbooks = (playbooksRes.data ?? []) as unknown as (Omit<TodayPlaybookInput, 'eligibility_criteria'> & { eligibility_criteria: ConditionGroup | null })[]

  const insightsByAccount = new Map<string, TodayInsightInput[]>()
  let criticalInsightCount = 0
  for (const row of (insightsRes.data ?? []) as { account_id: string; title: string; priority: string }[]) {
    const list = insightsByAccount.get(row.account_id) ?? []
    list.push({ title: row.title, priority: row.priority })
    insightsByAccount.set(row.account_id, list)
    if (row.priority === 'critical') criticalInsightCount++
  }

  const actions = computeTodayActions(accounts, playbooks as TodayPlaybookInput[], insightsByAccount)
  const summary = buildTodayActionsSummary(actions)
  const status = determinePortfolioStatus(criticalInsightCount, summary.total)

  return jsonResponse({
    data: {
      status,
      total: summary.total,
      by_priority: summary.by_priority,
      by_category: summary.by_category,
      mrr_at_risk_cents: summary.mrr_at_risk_cents,
      actions: summary.actions,
    },
  })
})
