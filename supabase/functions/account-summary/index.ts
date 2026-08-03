// ============================================================
// Edge Function : account-summary
// Génère ou retourne un résumé IA en anglais des métriques
// d'un compte client, mis en cache 24h dans accounts.ai_summary.
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// GET /account-summary?account_id=:uuid
//   Response 200 :
//     {
//       summary: string,
//       generated_at: string (ISO),
//       cached: boolean
//     }
//   Response 400 : { error: "account_id query parameter required" }
//   Response 404 : { error: "Account not found" }
//   Response 503 : { error: "AI service not configured" }
//
// Cache : 24h ou invalidé si scores recalculés depuis la dernière génération
// Auth  : JWT utilisateur vérifié dans le code (ES256 via verifyUserAuth)
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'

const SUMMARY_TTL_MS = 24 * 60 * 60 * 1000
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-haiku-4-5-20251001'
const FUNCTION_VERSION = '1.3.0'

// ── Entrypoint ───────────────────────────────────────────────

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
    console.error(JSON.stringify({ level: 'error', function_name: 'account-summary', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const url = new URL(req.url)
  const accountId = url.searchParams.get('account_id')
  if (!accountId) return errorResponse('account_id query parameter required', 400)

  const orgId = auth.organizationId

  const [accountRes, insightsRes, segmentsRes] = await Promise.all([
    supabase.from('accounts').select('*').eq('id', accountId).eq('organization_id', orgId).maybeSingle(),
    supabase
      .from('ai_insights')
      .select('insight_type, title, priority')
      .eq('account_id', accountId)
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .limit(5),
    supabase
      .from('segment_memberships')
      .select('account_segments(segment_type)')
      .eq('account_id', accountId)
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .limit(3),
  ])

  if (accountRes.error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'account-summary', organization_id: orgId, message: accountRes.error.message }))
    return errorResponse('Failed to fetch account', 500)
  }
  if (!accountRes.data) return errorResponse('Account not found', 404)

  const account = accountRes.data

  // Serve from cache if fresh and scores haven't been recalculated since
  if (account.ai_summary && account.ai_summary_generated_at) {
    const age = Date.now() - new Date(account.ai_summary_generated_at).getTime()
    const scoresNewerThanSummary = account.scores_calculated_at
      ? new Date(account.scores_calculated_at) > new Date(account.ai_summary_generated_at)
      : false
    if (age < SUMMARY_TTL_MS && !scoresNewerThanSummary) {
      return jsonResponse({ summary: account.ai_summary, generated_at: account.ai_summary_generated_at, cached: true })
    }
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    console.error(JSON.stringify({ level: 'error', function_name: 'account-summary', message: 'ANTHROPIC_API_KEY not set' }))
    return errorResponse('AI service not configured', 503)
  }

  const insights: string[] = (insightsRes.data ?? []).map(
    (i: { insight_type: string; title: string; priority: string }) => `${i.title} (${i.priority})`,
  )
  const segments: string[] = (segmentsRes.data ?? [])
    .map((s: { account_segments: { segment_type: string } | null }) => s.account_segments?.segment_type)
    .filter((v): v is string => Boolean(v))

  const monthsSinceCreated = account.created_at
    ? Math.max(0, Math.round((Date.now() - new Date(account.created_at).getTime()) / (30 * 24 * 60 * 60 * 1000)))
    : null

  const mrrDisplay = account.mrr_cents ? (account.mrr_cents / 100).toFixed(2) : '0.00'

  const userPrompt = buildPrompt({
    health_score: account.health_score,
    health_score_status: account.health_score_status,
    churn_risk_score: account.churn_risk_score,
    churn_risk_band: account.churn_risk_band,
    risk_signals_triggered: account.risk_signals_triggered ?? [],
    expansion_score: account.expansion_score,
    expansion_score_status: account.expansion_score_status,
    payment_health_score: account.payment_health_score,
    revenue_dynamics_score: account.revenue_dynamics_score,
    contract_renewal_score: account.contract_renewal_score,
    mrr_usd: mrrDisplay,
    plan_tier: account.plan_tier,
    billing_interval: account.billing_interval,
    months_since_created: monthsSinceCreated,
    segments,
    insights,
  })

  let summary: string
  try {
    const response = await fetchWithTimeout(
      ANTHROPIC_API_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 300,
          system:
            "You are an expert B2B SaaS analyst. You generate concise, professional summaries in English about the health of a customer account, based solely on anonymized metrics. You never invent information. You write 3 to 5 sentences maximum, with no title or bullet points.",
          messages: [{ role: 'user', content: userPrompt }],
        }),
      },
      15000,
    )

    if (!response.ok) {
      const errText = await response.text()
      console.error(JSON.stringify({ level: 'error', function_name: 'account-summary', organization_id: orgId, message: `Anthropic API ${response.status}: ${errText}` }))
      // Parse le message exact d'Anthropic pour l'exposer au frontend
      let anthropicMsg = errText
      try { anthropicMsg = JSON.parse(errText)?.error?.message ?? errText } catch { /* keep raw */ }
      return errorResponse(`AI generation failed (${response.status}): ${anthropicMsg.slice(0, 300)}`, 502)
    }

    const result = await response.json()
    summary = (result.content?.[0]?.text ?? '').trim()
    if (!summary) return errorResponse('AI generation returned empty result', 502)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'account-summary', organization_id: orgId, message: msg }))
    return errorResponse('AI generation failed', 502)
  }

  const generatedAt = new Date().toISOString()
  await supabase
    .from('accounts')
    .update({ ai_summary: summary, ai_summary_generated_at: generatedAt })
    .eq('id', accountId)
    .eq('organization_id', orgId)

  return jsonResponse({ summary, generated_at: generatedAt, cached: false })
})

// ── Prompt builder ───────────────────────────────────────────

interface PromptData {
  health_score: number | null
  health_score_status: 'complete' | 'partial' | 'insufficient' | null
  churn_risk_score: number | null
  churn_risk_band: 'low' | 'watch' | 'high' | null
  risk_signals_triggered: Array<{ label: string; severity: string }>
  expansion_score: number | null
  expansion_score_status: 'available' | 'unavailable' | null
  payment_health_score: number | null
  revenue_dynamics_score: number | null
  contract_renewal_score: number | null
  mrr_usd: string
  plan_tier: string | null
  billing_interval: string | null
  months_since_created: number | null
  segments: string[]
  insights: string[]
}

// Scoring Engine V2 (model_version 'v3') : payment_health/revenue_dynamics/
// contract_renewal remplacent financial/engagement/contract/product_usage.
// Un score `null` est explicitement décrit comme "not enough data" au lieu
// d'être omis ou affiché comme 0/50 — le prompt IA ne doit jamais halluciner
// un chiffre absent (contrainte système "never invent information").
function buildPrompt(data: PromptData): string {
  const fmtScore = (v: number | null) => (v === null ? 'not enough data' : `${v}/100`)

  const lines = [
    "Generate a summary of this customer account's status for a customer success manager.",
    '',
    'Metrics:',
    `- Overall health score: ${fmtScore(data.health_score)}${data.health_score_status === 'partial' ? ' (partial data coverage)' : ''}`,
    `- Churn risk: ${data.churn_risk_score ?? 'N/A'}/100 (${data.churn_risk_band ?? 'unknown'} band)`,
    ...(data.risk_signals_triggered.length > 0
      ? [`- Churn risk signals: ${data.risk_signals_triggered.map((s) => `${s.label} (${s.severity})`).join('; ')}`]
      : []),
    `- Payment health score: ${fmtScore(data.payment_health_score)}`,
    `- Revenue dynamics score: ${fmtScore(data.revenue_dynamics_score)}`,
    `- Contract renewal score: ${fmtScore(data.contract_renewal_score)}`,
    `- Expansion score: ${data.expansion_score_status === 'unavailable' ? 'not available (seat data not configured)' : fmtScore(data.expansion_score)}`,
    `- MRR: $${data.mrr_usd}`,
  ]

  if (data.plan_tier) {
    const interval = data.billing_interval ? ` (${data.billing_interval})` : ''
    lines.push(`- Plan: ${data.plan_tier}${interval}`)
  }
  if (data.months_since_created != null) lines.push(`- Customer for: ${data.months_since_created} months`)
  if (data.segments.length > 0) lines.push(`- Segment(s): ${data.segments.join(', ')}`)
  if (data.insights.length > 0) lines.push(`- Active alerts: ${data.insights.join('; ')}`)

  return lines.join('\n')
}
