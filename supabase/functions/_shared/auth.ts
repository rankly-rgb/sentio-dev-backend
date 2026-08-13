// ============================================================
// Auth helper — Vérification JWT utilisateur via Supabase Auth
// Nécessaire car verify_jwt=true rejette les JWT ES256 (ECDSA)
// utilisés par les projets Supabase récents.
// ============================================================

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { getTier } from './subscription-tiers.ts'
import { computeTrialStatus } from './trial-status.ts'

export interface AuthResult {
  userId: string
  organizationId: string
}

/**
 * Vérifie le JWT utilisateur via supabase.auth.getUser().
 * Retourne le user ID et l'organization_id depuis profiles_.
 * Throw une erreur si le token est invalide ou absent.
 */
export async function verifyUserAuth(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AuthError('Missing or invalid Authorization header', 401)
  }

  const token = authHeader.replace('Bearer ', '')
  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')

  if (!url || !anonKey) {
    throw new AuthError('Server configuration error', 500)
  }

  // Create a client with the user's token to verify it
  let supabase
  try {
    supabase = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    })
  } catch {
    throw new AuthError('Auth service configuration error', 500)
  }

  let user
  try {
    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data.user) {
      throw new AuthError('Invalid or expired token', 401)
    }
    user = data.user
  } catch (err) {
    if (err instanceof AuthError) throw err
    throw new AuthError('Auth service unavailable', 503)
  }

  // Resolve organization_id from profiles_
  const { data: profile, error: profileError } = await supabase
    .from('profiles_')
    .select('organization_id')
    .eq('auth_user_id', user.id)
    .maybeSingle()

  if (profileError || !profile?.organization_id) {
    throw new AuthError('User has no associated organization', 403)
  }

  return {
    userId: user.id,
    organizationId: profile.organization_id,
  }
}

export class AuthError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'AuthError'
    this.status = status
  }
}

/**
 * Extends AuthError (not a sibling class) so every one of the 39 existing
 * call sites — all written as `catch (err) { if (err instanceof AuthError)
 * return errorResponse(err.message, err.status) }` — forwards this
 * correctly with zero changes needed on their end. Status 402, matching
 * the contract already implemented and tested on the frontend
 * (fetchWithUserJwt.ts::TrialExpiredError) but never triggered until now.
 */
export class TrialExpiredError extends AuthError {
  constructor() {
    super('Trial expired — please upgrade your subscription', 402)
    this.name = 'TrialExpiredError'
  }
}

/**
 * Opt-in trial gate — called explicitly by the handful of "core value"
 * Edge Functions (see docs/openspec.md billing section) right after
 * verifyUserAuth, NOT baked into verifyUserAuth itself. Deliberately not
 * applied everywhere: auth/billing/onboarding/admin/monitoring endpoints
 * must stay reachable for an expired-trial org (to view its own status,
 * to upgrade, to finish signup, for Sentio ops) — an implicit blanket gate
 * risks silently locking out exactly the screens a stuck org needs.
 */
export async function assertTrialActive(supabase: SupabaseClient, organizationId: string): Promise<void> {
  const { data: org } = await supabase
    .from('organizations')
    .select('plan_type, trial_ends_at')
    .eq('id', organizationId)
    .maybeSingle()

  const tier = getTier(org?.plan_type ?? null)
  const status = computeTrialStatus(tier.key, org?.trial_ends_at ?? null, Date.now())

  if (status.is_trial_expired) {
    throw new TrialExpiredError()
  }
}
