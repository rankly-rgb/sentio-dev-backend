import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const PROTECTED_ROUTES = ['/dashboard', '/api/sync-stripe']
const AUTH_ROUTES = ['/auth/login', '/auth/callback']

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Skip static assets and non-protected routes
  const isProtected = PROTECTED_ROUTES.some((r) => pathname.startsWith(r))
  const isAuth = AUTH_ROUTES.some((r) => pathname.startsWith(r))
  if (!isProtected && !isAuth) return NextResponse.next()

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
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

  // Refresh session token — this keeps long sessions alive
  const { data: { user } } = await supabase.auth.getUser()

  // Redirect unauthenticated users away from protected routes
  if (isProtected && !user) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/auth/login'
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  // Redirect authenticated users away from auth routes
  if (isAuth && user && pathname !== '/auth/callback') {
    const dashboardUrl = request.nextUrl.clone()
    dashboardUrl.pathname = '/dashboard'
    return NextResponse.redirect(dashboardUrl)
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/dashboard/:path*', '/api/:path*', '/auth/:path*'],
}
