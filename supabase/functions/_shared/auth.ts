// ============================================================
// Auth helper — Vérification JWT utilisateur via Supabase Auth
// Nécessaire car verify_jwt=true rejette les JWT ES256 (ECDSA)
// utilisés par les projets Supabase récents.
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'

export interface AuthResult {
  userId: string
  organizationId: string | null
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
  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

  const { data: { user }, error } = await supabase.auth.getUser(token)

  if (error || !user) {
    throw new AuthError('Invalid or expired token', 401)
  }

  // Resolve organization_id from profiles_
  const { data: profile } = await supabase
    .from('profiles_')
    .select('organization_id')
    .eq('auth_user_id', user.id)
    .single()

  return {
    userId: user.id,
    organizationId: profile?.organization_id ?? null,
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
