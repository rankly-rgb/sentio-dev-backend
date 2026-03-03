import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseUrl, getSupabaseAnonKey } from '@/lib/env'

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

  return NextResponse.redirect(`${origin}${next}`)
}
