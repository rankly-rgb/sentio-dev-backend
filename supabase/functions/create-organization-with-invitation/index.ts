// ============================================================
// Edge Function : create-organization-with-invitation
// POST /create-organization-with-invitation
//
// Déclenchée par le frontend immédiatement après signUp().
// Crée l'organisation, le profil owner, les préférences par défaut
// et 4 comptes démo pour la révélation progressive.
//
// Zero-PII : l'email reçu en transit n'est JAMAIS persisté.
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'

// Comptes démo représentatifs pour la révélation progressive
const DEMO_ACCOUNTS = [
  { company_name: 'Acme SaaS',  mrr_cents: 240000, health_score: 82, churn_risk_score: 18, segment: 'Champions'     },
  { company_name: 'Nexio',      mrr_cents: 110000, health_score: 31, churn_risk_score: 72, segment: 'En danger'     },
  { company_name: 'TechFlow',   mrr_cents:  89000, health_score: 54, churn_risk_score: 48, segment: 'À risque léger' },
  { company_name: 'Strio',      mrr_cents:  99000, health_score: 67, churn_risk_score: 35, segment: 'Stables'       },
]

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  let auth
  try {
    auth = await verifyUserAuth(req)
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.message, err.status)
    return errorResponse('Authentication failed', 401)
  }

  let body: { user_id?: unknown; email?: unknown; company_name?: unknown; locale?: unknown }
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  const { user_id, company_name, locale } = body
  // email reçu en transit uniquement — jamais lu ni persisté

  if (!user_id || typeof user_id !== 'string') {
    return errorResponse('user_id est requis', 400)
  }
  if (!company_name || typeof company_name !== 'string' || company_name.trim().length === 0) {
    return errorResponse('company_name est requis', 400)
  }

  // Vérifier cohérence JWT / user_id
  if (auth.userId !== user_id) {
    return errorResponse('user_id ne correspond pas au token JWT', 403)
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'create-organization-with-invitation', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  // 1. Vérifier que l'utilisateur existe dans auth.users
  const { data: authUser, error: authErr } = await supabase.auth.admin.getUserById(user_id)
  if (authErr || !authUser?.user) {
    return errorResponse('Utilisateur introuvable', 400)
  }

  // 2. Vérifier si une organisation existe déjà (créée par le trigger SQL on_auth_user_created)
  const { data: existingProfile } = await supabase
    .from('profiles_')
    .select('organization_id')
    .eq('auth_user_id', user_id)
    .maybeSingle()

  const today = new Date().toISOString().split('T')[0]
  const resolvedLocale = (locale === 'en') ? 'en' : 'fr'
  const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()

  let orgId: string

  if (existingProfile?.organization_id) {
    // Org créée automatiquement par le trigger SQL — la mettre à jour avec les données du formulaire
    orgId = existingProfile.organization_id
    const { error: updateErr } = await supabase
      .from('organizations')
      .update({
        name: company_name.trim(),
        onboarding_step: 'promise',
        onboarding_completed: false,
        locale: resolvedLocale,
        trial_ends_at: trialEndsAt,
      })
      .eq('id', orgId)

    if (updateErr) {
      console.error(JSON.stringify({ level: 'error', function_name: 'create-organization-with-invitation', message: updateErr.message }))
      return errorResponse('Erreur mise à jour organisation', 500)
    }
  } else {
    // Pas de trigger actif — créer l'organisation from scratch
    const { data: org, error: orgErr } = await supabase
      .from('organizations')
      .insert({
        name: company_name.trim(),
        onboarding_step: 'promise',
        onboarding_completed: false,
        plan_type: 'free',
        trial_ends_at: trialEndsAt,
        locale: resolvedLocale,
      })
      .select('id')
      .single()

    if (orgErr || !org) {
      console.error(JSON.stringify({ level: 'error', function_name: 'create-organization-with-invitation', message: orgErr?.message ?? 'org insert failed' }))
      return errorResponse('Erreur création organisation', 500)
    }

    orgId = org.id

    // Créer le profil owner
    const { error: profileErr } = await supabase
      .from('profiles_')
      .insert({ organization_id: orgId, auth_user_id: user_id, role: 'admin' })

    if (profileErr) {
      console.error(JSON.stringify({ level: 'error', function_name: 'create-organization-with-invitation', message: profileErr.message }))
      await supabase.from('organizations').delete().eq('id', orgId)
      return errorResponse('Erreur création profil', 500)
    }
  }

  // 4. Créer les préférences par défaut (idempotent — ignore conflict)
  await supabase.from('org_preferences').upsert({ organization_id: orgId }, { onConflict: 'organization_id', ignoreDuplicates: true })

  // 5. Insérer les 4 comptes démo
  const { data: demoAccounts, error: demoErr } = await supabase
    .from('accounts')
    .insert(
      DEMO_ACCOUNTS.map(({ company_name: cn, mrr_cents }) => ({
        organization_id: orgId,
        company_name: cn,
        mrr_cents,
        is_demo: true,
      }))
    )
    .select('id, company_name')

  if (demoErr || !demoAccounts?.length) {
    console.error(JSON.stringify({ level: 'error', function_name: 'create-organization-with-invitation', message: demoErr?.message ?? 'demo insert failed' }))
    // Non bloquant — l'org est créée
  }

  // 6. Insérer les score_history des comptes démo
  if (demoAccounts?.length) {
    const scoreRows = demoAccounts.map((acc) => {
      const demo = DEMO_ACCOUNTS.find(d => d.company_name === acc.company_name)!
      return {
        organization_id: orgId,
        account_id: acc.id,
        snapshot_date: today,
        health_score: demo.health_score,
        churn_risk_score: demo.churn_risk_score,
        segment: demo.segment,
      }
    })

    await supabase
      .from('score_history')
      .upsert(scoreRows, { onConflict: 'organization_id,account_id,snapshot_date' })
  }

  console.log(JSON.stringify({
    level: 'info',
    function_name: 'create-organization-with-invitation',
    organization_id: orgId,
    demo_accounts: demoAccounts?.length ?? 0,
  }))

  return jsonResponse({
    organization_id: orgId,
    onboarding_step: 'promise',
    has_demo_data: (demoAccounts?.length ?? 0) > 0,
  })
})
