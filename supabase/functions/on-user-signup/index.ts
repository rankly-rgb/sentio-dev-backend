// ============================================================
// Edge Function : on-user-signup
// Appelée par le frontend immédiatement après supabase.auth.signUp().
// Envoie l'email de bienvenue et retourne les données de l'organisation
// créée par le trigger SQL handle_new_user_signup().
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// POST /on-user-signup
//   Auth : JWT utilisateur (ES256 via verifyUserAuth)
//   Body : {} (vide)
//   Response 200 :
//     {
//       success: true,
//       organization: {
//         id: string,
//         name: string,
//         plan_type: string,
//         trial_ends_at: string | null
//       }
//     }
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { sendEmail } from '../_shared/resend.ts'

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

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'on-user-signup', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const orgId = auth.organizationId

  const [orgRes, profileRes] = await Promise.all([
    supabase
      .from('organizations')
      .select('id, name, plan_type, trial_ends_at, locale')
      .eq('id', orgId)
      .maybeSingle(),
    supabase
      .from('profiles_')
      .select('email')
      .eq('organization_id', orgId)
      .maybeSingle(),
  ])

  if (orgRes.error || !orgRes.data) {
    const msg = orgRes.error?.message ?? 'Organization not found'
    console.error(JSON.stringify({ level: 'error', function_name: 'on-user-signup', message: msg }))
    return errorResponse('Organization not found', 404)
  }

  const org = orgRes.data
  const email = profileRes.data?.email ?? null
  const locale: 'fr' | 'en' = org.locale === 'en' ? 'en' : 'fr'

  if (email) {
    const isEN = locale === 'en'
    const emailResult = await sendEmail({
      to: email,
      subject: isEN
        ? 'Welcome to Sentio AI — your 14-day trial starts now'
        : 'Bienvenue sur Sentio AI — votre essai de 14 jours commence',
      html: isEN
        ? buildWelcomeEmailEN(org.name, org.trial_ends_at)
        : buildWelcomeEmail(org.name, org.trial_ends_at),
      from_name: 'Sentio AI',
    })

    if (!emailResult.success && !emailResult.log_only) {
      console.error(JSON.stringify({
        level: 'warn',
        function_name: 'on-user-signup',
        message: 'Welcome email failed',
        error: emailResult.error,
      }))
    }
  }

  return jsonResponse({
    success: true,
    organization: {
      id: org.id,
      name: org.name,
      plan_type: org.plan_type,
      trial_ends_at: org.trial_ends_at,
    },
  })
})

// ── Helpers exportés pour les tests ──────────────────────────

export function formatTrialEndDate(trialEndsAt: string | null): string {
  if (!trialEndsAt) return '14 jours'
  const date = new Date(trialEndsAt)
  if (isNaN(date.getTime())) return '14 jours'
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
}

export function formatTrialEndDateEN(trialEndsAt: string | null): string {
  if (!trialEndsAt) return '14 days'
  const date = new Date(trialEndsAt)
  if (isNaN(date.getTime())) return '14 days'
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

export function buildWelcomeEmailEN(orgName: string, trialEndsAt: string | null): string {
  const trialDate = formatTrialEndDateEN(trialEndsAt)
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Welcome to Sentio AI</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1a1a1a">
  <h1 style="color:#0f172a">Welcome to Sentio AI 👋</h1>
  <p>Your <strong>${orgName}</strong> workspace is ready. Your free trial runs until <strong>${trialDate}</strong>.</p>
  <h2 style="color:#0f172a;margin-top:32px">Your first 3 steps</h2>
  <ol>
    <li style="margin-bottom:12px"><strong>Connect Stripe</strong> — import your subscriptions in 2 minutes.</li>
    <li style="margin-bottom:12px"><strong>Connect HubSpot</strong> (optional) — enrich your engagement data.</li>
    <li style="margin-bottom:12px"><strong>Discover your aha moment</strong> — identify at-risk accounts in real time.</li>
  </ol>
  <a href="https://app.sentio.ai/dashboard/onboarding"
     style="display:inline-block;margin-top:24px;padding:12px 24px;background:#0f172a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">
    Go to dashboard
  </a>
  <p style="margin-top:40px;font-size:13px;color:#6b7280">
    You received this email because you just created a Sentio AI account.<br>
    Questions? Reply directly to this email.
  </p>
</body>
</html>`
}

export function buildWelcomeEmail(orgName: string, trialEndsAt: string | null): string {
  const trialDate = formatTrialEndDate(trialEndsAt)
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><title>Bienvenue sur Sentio AI</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1a1a1a">
  <h1 style="color:#0f172a">Bienvenue sur Sentio AI 👋</h1>
  <p>Votre espace <strong>${orgName}</strong> est prêt. Votre essai gratuit est valable jusqu'au <strong>${trialDate}</strong>.</p>
  <h2 style="color:#0f172a;margin-top:32px">Vos 3 premières étapes</h2>
  <ol>
    <li style="margin-bottom:12px"><strong>Connectez Stripe</strong> — importez vos abonnements en 2 minutes.</li>
    <li style="margin-bottom:12px"><strong>Connectez HubSpot</strong> (optionnel) — enrichissez les données d'engagement.</li>
    <li style="margin-bottom:12px"><strong>Découvrez votre aha moment</strong> — identifiez vos comptes à risque en temps réel.</li>
  </ol>
  <a href="https://app.sentio.ai/dashboard/onboarding"
     style="display:inline-block;margin-top:24px;padding:12px 24px;background:#0f172a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">
    Accéder au tableau de bord
  </a>
  <p style="margin-top:40px;font-size:13px;color:#6b7280">
    Vous recevez cet email car vous venez de créer un compte Sentio AI.<br>
    En cas de question, répondez directement à cet email.
  </p>
</body>
</html>`
}

export function validateOrgData(org: unknown): { valid: boolean; error?: string } {
  if (org === null || org === undefined) return { valid: false, error: 'Organization is required' }
  if (typeof org !== 'object') return { valid: false, error: 'Organization must be an object' }
  return { valid: true }
}
