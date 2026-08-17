// ============================================================
// Edge Function : create-organization-with-invitation
// POST /create-organization-with-invitation
//
// Déclenchée par le frontend immédiatement après signUp().
// Crée l'organisation, le profil owner et les préférences par défaut.
//
// Zero-PII : l'email reçu en transit n'est JAMAIS persisté.
//
// 2026-08-17 : le seed de 4 comptes démo ("révélation progressive")
// retiré — code écrit pour le flux V2 en pause (CreateOrganizationResponse
// matche onboarding-v2.ts), câblé par erreur sur ce chemin V1 réel
// (Signup.tsx → useCreateOrganization). Il ciblait des colonnes qui
// n'ont jamais existé sur le schéma V1 (`accounts.company_name`,
// `accounts.is_demo`, `score_history.segment` — vérifié en direct,
// aucune des trois sur le projet dev) : l'insert échouait silencieusement
// à chaque inscription depuis toujours (erreur loguée, non bloquante),
// zéro compte démo n'a jamais atteint une org réelle. Voir aussi
// get-onboarding-status-v2 (même cause, `has_demo_data` retiré au même
// chantier) et Dashboard.tsx (bandeau démo jamais affiché, retiré aussi).

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { withSentry } from '../_shared/sentry.ts'

Deno.serve(withSentry('create-organization-with-invitation', async (req: Request): Promise<Response> => {
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

  let body: { user_id?: unknown; email?: unknown; company_name?: unknown }
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  const { user_id, company_name } = body
  // email reçu en transit uniquement — jamais lu ni persisté

  if (!user_id || typeof user_id !== 'string') {
    return errorResponse('user_id is required', 400)
  }
  if (!company_name || typeof company_name !== 'string' || company_name.trim().length === 0) {
    return errorResponse('company_name is required', 400)
  }

  // Vérifier cohérence JWT / user_id
  if (auth.userId !== user_id) {
    return errorResponse('user_id does not match the JWT token', 403)
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
    return errorResponse('User not found', 400)
  }

  // 2. Vérifier si une organisation existe déjà (créée par le trigger SQL on_auth_user_created)
  const { data: existingProfile } = await supabase
    .from('profiles_')
    .select('organization_id')
    .eq('auth_user_id', user_id)
    .maybeSingle()

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
        trial_ends_at: trialEndsAt,
      })
      .eq('id', orgId)

    if (updateErr) {
      console.error(JSON.stringify({ level: 'error', function_name: 'create-organization-with-invitation', message: updateErr.message }))
      return errorResponse('Failed to update organization', 500)
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
      })
      .select('id')
      .single()

    if (orgErr || !org) {
      console.error(JSON.stringify({ level: 'error', function_name: 'create-organization-with-invitation', message: orgErr?.message ?? 'org insert failed' }))
      return errorResponse('Failed to create organization', 500)
    }

    orgId = org.id

    // Créer le profil owner
    const { error: profileErr } = await supabase
      .from('profiles_')
      .insert({ organization_id: orgId, auth_user_id: user_id, role: 'admin' })

    if (profileErr) {
      console.error(JSON.stringify({ level: 'error', function_name: 'create-organization-with-invitation', message: profileErr.message }))
      await supabase.from('organizations').delete().eq('id', orgId)
      return errorResponse('Failed to create profile', 500)
    }
  }

  // 4. Créer les préférences par défaut (idempotent — ignore conflict)
  await supabase.from('org_preferences').upsert({ organization_id: orgId }, { onConflict: 'organization_id', ignoreDuplicates: true })

  console.log(JSON.stringify({
    level: 'info',
    function_name: 'create-organization-with-invitation',
    organization_id: orgId,
  }))

  return jsonResponse({
    organization_id: orgId,
    onboarding_step: 'promise',
  })
}))
