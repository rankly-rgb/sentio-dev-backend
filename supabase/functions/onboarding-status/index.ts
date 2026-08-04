// ============================================================
// Edge Function : onboarding-status
// Expose et met à jour l'état d'onboarding de l'organisation.
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// GET /onboarding-status
//   Response 200 :
//     {
//       data: {
//         stripe_connected: boolean,
//         hubspot_connected: boolean,
//         first_score_calculated: boolean,
//         aha_moment_ready: boolean,
//         aha_moment_seen: boolean,        // alias first_win_seen
//         onboarding_completed: boolean,
//         current_step: 'stripe' | 'hubspot' | 'first_win' | 'done',
//         first_score_calculated_at: string | null,
//         aha_moment_seen_at: string | null,
//         accounts_count: number,
//         at_risk_count: number,           // comptes avec health_score < 40
//         top_risk_account: {
//           id: string,
//           stripe_customer_id: string,
//           display_name: string | null,
//           churn_risk_score: number,
//           health_score: number
//         } | null
//       }
//     }
//
// PATCH /onboarding-status
//   Body : { field: 'first_win_seen' | 'onboarding_completed', value: true }
//   Response 200 : { success: true }
//
// POST /onboarding-status/aha-seen   (conservé pour rétrocompatibilité)
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

  // POST .../aha-seen — rétrocompatibilité
  if (req.method === 'POST' && path === 'aha-seen') {
    return handleAhaSeen(supabase, orgId)
  }

  if (req.method === 'PATCH') return handlePatch(supabase, orgId, req)

  if (req.method === 'GET') return handleGetStatus(supabase, orgId)

  return errorResponse('Method not allowed', 405)
})

// ── GET /onboarding-status ───────────────────────────────────

export type WizardStepStatus = 'completed' | 'active' | 'pending'

export interface WizardStep {
  id: string
  label: string
  required: boolean
  status: WizardStepStatus
}

export function buildWizardSteps(
  stripeConnected: boolean,
  firstScoreCalculated: boolean,
  ahaMomentSeen: boolean,
  hubspotConnected: boolean,
  onboardingCompleted: boolean,
): WizardStep[] {
  return [
    {
      id: 'stripe',
      label: 'Connect Stripe',
      required: true,
      status: stripeConnected ? 'completed' : 'active',
    },
    {
      id: 'import',
      label: 'Import data',
      required: true,
      status: !stripeConnected ? 'pending' : firstScoreCalculated ? 'completed' : 'active',
    },
    {
      id: 'first_win',
      label: 'First insight',
      required: true,
      status: !firstScoreCalculated ? 'pending' : ahaMomentSeen ? 'completed' : 'active',
    },
    {
      id: 'hubspot',
      label: 'Connect HubSpot',
      required: false,
      status: hubspotConnected || onboardingCompleted ? 'completed' : !ahaMomentSeen ? 'pending' : 'active',
    },
  ]
}

async function handleGetStatus(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
): Promise<Response> {
  // stripe_connected et hubspot_connected lus depuis organizations (source de vérité)
  // data_syncs utilisé uniquement pour le statut running du sync en cours
  const [orgRes, stripeSyncRunningRes, accountsCountRes, atRiskCountRes] = await Promise.all([
    supabase.from('organizations')
      .select('stripe_connected, hubspot_connected, first_score_calculated_at, aha_moment_seen_at, onboarding_completed, billing_profile, billing_profile_flags')
      .eq('id', orgId)
      .maybeSingle(),
    supabase.from('data_syncs')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('sync_source', 'stripe')
      .eq('sync_status', 'running')
      .limit(1),
    supabase.from('accounts')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId),
    supabase.from('accounts')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .lt('health_score', 40),
  ])

  if (orgRes.error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'onboarding-status', message: orgRes.error.message }))
    return errorResponse('Failed to fetch organization', 500)
  }

  const org = orgRes.data
  const stripeConnected = org?.stripe_connected ?? false
  const hubspotConnected = org?.hubspot_connected ?? false
  const stripeSyncInProgress = (stripeSyncRunningRes.count ?? 0) > 0
  const accountsCount = accountsCountRes.count ?? 0
  const atRiskCount = atRiskCountRes.count ?? 0
  const onboardingCompleted = org?.onboarding_completed ?? false

  const firstScoreAt = org?.first_score_calculated_at ?? null
  let firstScoreCalculated = firstScoreAt !== null

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

  const currentStep = determineCurrentStep(stripeConnected, hubspotConnected, ahaMomentSeen, onboardingCompleted)
  const wizardSteps = buildWizardSteps(stripeConnected, firstScoreCalculated, ahaMomentSeen, hubspotConnected, onboardingCompleted)

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
      stripe_sync_in_progress: stripeSyncInProgress,
      hubspot_connected: hubspotConnected,
      first_score_calculated: firstScoreCalculated,
      aha_moment_ready: ahaMomentReady,
      aha_moment_seen: ahaMomentSeen,
      onboarding_completed: onboardingCompleted,
      current_step: currentStep,
      wizard_steps: wizardSteps,
      first_score_calculated_at: firstScoreAt,
      aha_moment_seen_at: org?.aha_moment_seen_at ?? null,
      accounts_count: accountsCount,
      at_risk_count: atRiskCount,
      top_risk_account: topRiskAccount,
      // Phase 3 (docs/openspec.md §11) : 'needs_review' quand sync-stripe a
      // détecté une configuration Stripe non-standard (invoice-only,
      // metered, prix sans unit_amount, multi-devises, subscription
      // schedules) — null tant qu'aucun sync complet n'a encore tourné.
      billing_profile: org?.billing_profile ?? null,
      billing_profile_flags: org?.billing_profile_flags ?? null,
    },
  })
}

export function determineCurrentStep(
  stripeConnected: boolean,
  hubspotConnected: boolean,
  firstWinSeen: boolean,
  onboardingCompleted: boolean,
): 'stripe' | 'hubspot' | 'first_win' | 'done' {
  if (!stripeConnected) return 'stripe'
  if (!hubspotConnected && !onboardingCompleted) return 'hubspot'
  if (!firstWinSeen) return 'first_win'
  return 'done'
}

// ── PATCH /onboarding-status ─────────────────────────────────

async function handlePatch(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
  req: Request,
): Promise<Response> {
  let body: { field: unknown; value: unknown }
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  const { field, value } = body

  if (value !== true) {
    return errorResponse('value must be true', 400)
  }

  if (field === 'first_win_seen') {
    const now = new Date().toISOString()
    const { error } = await supabase
      .from('organizations')
      .update({ aha_moment_seen_at: now })
      .eq('id', orgId)
      .is('aha_moment_seen_at', null) // idempotent
    if (error) {
      console.error(JSON.stringify({ level: 'error', function_name: 'onboarding-status', message: error.message }))
      return errorResponse('Failed to mark first win as seen', 500)
    }
    return jsonResponse({ success: true })
  }

  if (field === 'onboarding_completed') {
    const { error } = await supabase
      .from('organizations')
      .update({ onboarding_completed: true })
      .eq('id', orgId)
    if (error) {
      console.error(JSON.stringify({ level: 'error', function_name: 'onboarding-status', message: error.message }))
      return errorResponse('Failed to mark onboarding as completed', 500)
    }
    return jsonResponse({ success: true })
  }

  return errorResponse('Invalid field. Must be first_win_seen or onboarding_completed', 400)
}

// ── POST /onboarding-status/aha-seen  (rétrocompatibilité) ───

async function handleAhaSeen(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
): Promise<Response> {
  const now = new Date().toISOString()

  const { error } = await supabase
    .from('organizations')
    .update({ aha_moment_seen_at: now })
    .eq('id', orgId)
    .is('aha_moment_seen_at', null)

  if (error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'onboarding-status', message: error.message }))
    return errorResponse('Failed to mark aha moment as seen', 500)
  }

  const { data: org } = await supabase
    .from('organizations')
    .select('aha_moment_seen_at')
    .eq('id', orgId)
    .maybeSingle()

  return jsonResponse({ data: { aha_moment_seen_at: org?.aha_moment_seen_at ?? now } })
}
