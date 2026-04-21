// ============================================================
// Edge Function : account-summary
// Génère ou retourne un résumé IA en français des métriques
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
const MODEL = 'claude-haiku-4-5'
const FUNCTION_VERSION = '1.2.0'

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

  const mrrEuros = account.mrr_cents ? (account.mrr_cents / 100).toFixed(2) : '0.00'

  const userPrompt = buildPrompt({
    health_score: account.health_score,
    churn_risk_score: account.churn_risk_score,
    expansion_score: account.expansion_score,
    financial_score: account.financial_score,
    engagement_score: account.engagement_score,
    contract_score: account.contract_score,
    product_usage_score: account.product_usage_score,
    mrr_euros: mrrEuros,
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
            "Tu es un analyste SaaS B2B expert. Tu génères des résumés concis et professionnels en français sur la santé d'un compte client, basés uniquement sur des métriques anonymisées. Tu n'inventes aucune information. Tu écris 3 à 5 phrases maximum, sans titre ni liste à puces.",
          messages: [{ role: 'user', content: userPrompt }],
        }),
      },
      15000,
    )

    if (!response.ok) {
      const errText = await response.text()
      console.error(JSON.stringify({ level: 'error', function_name: 'account-summary', organization_id: orgId, message: `Anthropic API ${response.status}: ${errText}` }))
      // Expose le status Anthropic pour faciliter le diagnostic (401/403/404/429)
      return errorResponse(`AI generation failed (Anthropic ${response.status})`, 502)
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
  churn_risk_score: number | null
  expansion_score: number | null
  financial_score: number | null
  engagement_score: number | null
  contract_score: number | null
  product_usage_score: number | null
  mrr_euros: string
  plan_tier: string | null
  billing_interval: string | null
  months_since_created: number | null
  segments: string[]
  insights: string[]
}

function buildPrompt(data: PromptData): string {
  const lines = [
    "Génère un résumé de l'état de ce compte client pour un customer success manager.",
    '',
    'Métriques :',
    `- Score de santé global : ${data.health_score ?? 'N/A'}/100`,
    `- Risque de churn : ${data.churn_risk_score ?? 'N/A'}/100`,
    `- Score financier : ${data.financial_score ?? 'N/A'}/100`,
    `- Score d'engagement : ${data.engagement_score ?? 'N/A'}/100`,
    `- Score contrat : ${data.contract_score ?? 'N/A'}/100`,
    `- Score d'usage produit : ${data.product_usage_score != null ? `${data.product_usage_score}/100` : 'Tracker non connecté'}`,
    `- MRR : ${data.mrr_euros}€`,
  ]

  if (data.plan_tier) {
    const interval = data.billing_interval ? ` (${data.billing_interval})` : ''
    lines.push(`- Plan : ${data.plan_tier}${interval}`)
  }
  if (data.months_since_created != null) lines.push(`- Client depuis : ${data.months_since_created} mois`)
  if (data.segments.length > 0) lines.push(`- Segment(s) : ${data.segments.join(', ')}`)
  if (data.insights.length > 0) lines.push(`- Alertes actives : ${data.insights.join('; ')}`)

  return lines.join('\n')
}
