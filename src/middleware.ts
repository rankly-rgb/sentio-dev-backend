import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const PROTECTED_ROUTES = ['/dashboard', '/api/sync-stripe']
const AUTH_ROUTES = ['/auth/login', '/auth/callback']
const ONBOARDING_ROUTES = ['/onboarding']

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  const isProtected = PROTECTED_ROUTES.some((r) => pathname.startsWith(r))
  const isAuth = AUTH_ROUTES.some((r) => pathname.startsWith(r))
  const isOnboarding = ONBOARDING_ROUTES.some((r) => pathname.startsWith(r))

  if (!isProtected && !isAuth && !isOnboarding) return NextResponse.next()

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  let user = null
  try {
    const authStart = Date.now()
    const { data } = await supabase.auth.getUser()
    const authDuration = Date.now() - authStart
    user = data.user
    if (authDuration > 2000) {
      console.error('[SENTIO_DEBUG][middleware-auth]', {
        type: 'slow_auth',
        duration_ms: authDuration,
        pathname,
        timestamp: new Date().toISOString(),
      })
    }
  } catch (err) {
    console.error('[SENTIO_DEBUG][middleware-auth]', {
      type: 'auth_error',
      message: err instanceof Error ? err.message : String(err),
      pathname,
      timestamp: new Date().toISOString(),
    })
    if (isProtected) {
      return new Response(
        JSON.stringify({ error: 'Service temporairement indisponible' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return supabaseResponse
  }

  // Utilisateur non authentifié sur une route protégée → login
  if ((isProtected || isOnboarding) && !user) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/auth/login'
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  // Utilisateur authentifié sur une route auth → dashboard (sauf callback)
  if (isAuth && user && pathname !== '/auth/callback') {
    const dashboardUrl = request.nextUrl.clone()
    dashboardUrl.pathname = '/dashboard'
    return NextResponse.redirect(dashboardUrl)
  }

  // Guard onboarding : si l'utilisateur accède à /dashboard sans avoir terminé l'onboarding
  if (isProtected && user) {
    const { data: profile } = await supabase
      .from('profiles_')
      .select('organization_id, organizations(onboarding_completed, stripe_connected)')
      .eq('auth_user_id', user.id)
      .maybeSingle()

    // @ts-expect-error — Supabase join type
    const org = profile?.organizations as { onboarding_completed: boolean; stripe_connected: boolean } | null

    // Onboarding non terminé ET Stripe non connecté → forcer l'onboarding
    if (org && !org.onboarding_completed && !org.stripe_connected) {
      const onboardingUrl = request.nextUrl.clone()
      onboardingUrl.pathname = '/onboarding/promise'
      return NextResponse.redirect(onboardingUrl)
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/dashboard/:path*', '/api/:path*', '/auth/:path*', '/onboarding/:path*'],
}
