// ============================================================
// Edge Function : pricing-status
// GET /pricing-status
// Gating par palier tarifaire + alerte d'approche de limite (US1).
// cf. specs/003-pricing-billing-implementation/contracts/pricing-billing-api.md
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { checkAccountLimitGate, type PlanTier, type TierLimits } from '../_shared/pricing.ts'

// ── Entrypoint ──────────────────────────────────────────────

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
    console.error(JSON.stringify({ level: 'error', function_name: 'pricing-status', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  return handlePricingStatus(supabase, auth.organizationId)
})

// ── Handler ─────────────────────────────────────────────────

export async function handlePricingStatus(
  supabase: SupabaseClient,
  orgId: string,
): Promise<Response> {
  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .select('plan_type')
    .eq('id', orgId)
    .maybeSingle()

  if (orgError || !org) return errorResponse('Organization not found', 404)

  const planTier = (org.plan_type as PlanTier) ?? 'free'

  const { data: limits, error: limitsError } = await supabase
    .from('pricing_tier_limits')
    .select('plan_tier, max_active_accounts, requires_appointment, alert_threshold_pct')
    .eq('plan_tier', planTier)
    .maybeSingle()

  if (limitsError || !limits) {
    console.error(JSON.stringify({ level: 'error', function_name: 'pricing-status', message: `No pricing_tier_limits row for plan_tier=${planTier}` }))
    return errorResponse('Pricing tier limits not configured', 500)
  }

  const { count: activeAccountCount } = await supabase
    .from('accounts')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .gt('mrr_cents', 0)

  const accountCount = activeAccountCount ?? 0
  const tierLimits = limits as TierLimits
  const gate = checkAccountLimitGate(accountCount, tierLimits)

  await syncPlanLimitInsight(supabase, orgId, gate.alert_active, accountCount, tierLimits)

  return jsonResponse({
    plan_tier: planTier,
    active_accounts_count: accountCount,
    max_active_accounts: tierLimits.max_active_accounts,
    usage_pct: gate.usage_pct,
    alert_active: gate.alert_active,
    requires_appointment: tierLimits.requires_appointment,
  })
}

// ── Insight plan_limit_warning (T013) ─────────────────────────
// Insight au niveau organisation (account_id = NULL) — créé quand
// l'alerte s'active, auto-résolu quand elle se lève (cf. spec.md
// Acceptance Scenario 3 US1 : "l'alerte et le gating se lèvent").

export async function syncPlanLimitInsight(
  supabase: SupabaseClient,
  orgId: string,
  alertActive: boolean,
  activeAccountCount: number,
  tierLimits: TierLimits,
): Promise<void> {
  const { data: existing } = await supabase
    .from('ai_insights')
    .select('id')
    .eq('organization_id', orgId)
    .eq('insight_type', 'plan_limit_warning')
    .eq('status', 'active')
    .is('account_id', null)
    .maybeSingle()

  if (alertActive) {
    if (existing) return // déjà une alerte active — pas de doublon

    const { error } = await supabase.from('ai_insights').insert({
      organization_id: orgId,
      account_id: null,
      insight_type: 'plan_limit_warning',
      title: 'Approaching active accounts limit',
      description: `Your organization tracks ${activeAccountCount} active accounts out of a limit of ${tierLimits.max_active_accounts} (${tierLimits.plan_tier} plan).`,
      priority: 'high',
      metadata: {
        severity: 'MAJEUR',
        signals: [
          `active_accounts_count:${activeAccountCount}`,
          `max_active_accounts:${tierLimits.max_active_accounts}`,
          `usage_pct:${tierLimits.max_active_accounts ? Math.round((activeAccountCount / tierLimits.max_active_accounts) * 100) : 0}`,
        ],
      },
    })
    if (error) {
      // Best-effort : une violation d'unicité (race, même jour) ne doit
      // jamais faire échouer GET /pricing-status.
      console.warn(JSON.stringify({ level: 'warn', function_name: 'pricing-status', op: 'insert_insight', message: error.message }))
    }
  } else if (existing) {
    await supabase
      .from('ai_insights')
      .update({ status: 'resolved', resolved_at: new Date().toISOString() })
      .eq('id', existing.id)
  }
}
