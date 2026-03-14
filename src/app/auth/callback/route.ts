import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseUrl, getSupabaseAnonKey } from '@/lib/env'
import { createSupabaseServiceClient } from '@/lib/supabase/server'

export async function GET(req: NextRequest) {
  const { searchParams, origin } = new URL(req.url)
  const code = searchParams.get('code')
  const rawNext = searchParams.get('next') ?? '/dashboard'

  // Validate redirect path — must be a safe relative path to prevent open redirects
  // Also decode to catch encoded bypass attempts like /%2F%2Fevil.com
  const decoded = decodeURIComponent(rawNext)
  const next = (decoded.startsWith('/') && !decoded.startsWith('//') && !decoded.includes('://')) ? decoded : '/dashboard'

  if (!code) {
    return NextResponse.redirect(`${origin}/auth/login?error=missing_code`)
  }

  const cookieStore = cookies()
  const supabase = createServerClient(
    getSupabaseUrl(),
    getSupabaseAnonKey(),
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        },
      },
    },
  )

  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    console.error('[auth/callback] error:', error.message)
    return NextResponse.redirect(`${origin}/auth/login?error=auth_failed`)
  }

  // Safeguard: ensure profile exists (belt-and-suspenders for the DB trigger)
  await ensureProfile(supabase)

  return NextResponse.redirect(`${origin}${next}`)
}

/**
 * Ensures the authenticated user has a profiles_ row.
 * The DB trigger on auth.users handles most cases, but this catches
 * edge cases (existing users before trigger, race conditions).
 * Uses service_role to bypass RLS for profile creation.
 */
async function ensureProfile(userClient: ReturnType<typeof createServerClient>) {
  try {
    const { data: { user } } = await userClient.auth.getUser()
    if (!user) return

    // Check if profile already exists (via user's own client — RLS allows own profile)
    const serviceClient = createSupabaseServiceClient()
    const { data: existing } = await serviceClient
      .from('profiles_')
      .select('id, organization_id')
      .eq('auth_user_id', user.id)
      .maybeSingle()

    // Profile exists with valid org — nothing to do
    if (existing?.organization_id) return

    // Profile exists but organization_id is NULL — try to repair it
    if (existing && !existing.organization_id) {
      // Look for invitation first
      const { data: inv } = await serviceClient
        .from('invitations')
        .select('id, organization_id, role')
        .eq('email', user.email)
        .is('accepted_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      let orgId = inv?.organization_id ?? null

      // Fallback: first active organization (beta single-org mode)
      if (!orgId) {
        const { data: defaultOrg } = await serviceClient
          .from('organizations')
          .select('id')
          .eq('is_active', true)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle()
        orgId = defaultOrg?.id ?? null
      }

      if (orgId) {
        const updateFields: Record<string, unknown> = { organization_id: orgId }
        if (inv?.role) updateFields.role = inv.role
        await serviceClient
          .from('profiles_')
          .update(updateFields)
          .eq('id', existing.id)

        if (inv?.id) {
          await serviceClient
            .from('invitations')
            .update({ accepted_at: new Date().toISOString() })
            .eq('id', inv.id)
        }

        console.log(`[auth/callback] Repaired NULL org_id for user ${user.id} → ${orgId}`)
      }
      return
    }

    // Look for a valid invitation to resolve organization_id
    const { data: invitation } = await serviceClient
      .from('invitations')
      .select('id, organization_id, role')
      .eq('email', user.email)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // Resolve org_id: invitation → fallback to first active org (beta)
    let newOrgId = invitation?.organization_id ?? null
    if (!newOrgId) {
      const { data: defaultOrg } = await serviceClient
        .from('organizations')
        .select('id')
        .eq('is_active', true)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      newOrgId = defaultOrg?.id ?? null
    }

    // Create profile with service_role (bypasses RLS)
    await serviceClient
      .from('profiles_')
      .insert({
        auth_user_id: user.id,
        email: user.email,
        organization_id: newOrgId,
        role: invitation?.role ?? 'member',
      })

    // Mark invitation as accepted
    if (invitation?.id) {
      await serviceClient
        .from('invitations')
        .update({ accepted_at: new Date().toISOString() })
        .eq('id', invitation.id)
    }
  } catch (err) {
    // Non-blocking: log but don't fail the auth flow
    console.error('[auth/callback] ensureProfile error:', err)
  }
}
