import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseUrl, getSupabaseAnonKey } from '@/lib/env'

export async function GET(req: NextRequest) {
  const { searchParams, origin } = new URL(req.url)
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type')
  const rawNext = searchParams.get('next') ?? '/dashboard'

  const decoded = decodeURIComponent(rawNext)
  const next = (decoded.startsWith('/') && !decoded.startsWith('//') && !decoded.includes('://')) ? decoded : '/dashboard'

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

  // Cas 1 : lien email Supabase (token_hash + type)
  // Supabase envoie ?token_hash=...&type=signup pour les confirmations email
  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as 'signup' | 'recovery' | 'email',
    })

    if (error) {
      console.error('[auth/callback] verifyOtp error:', error.message)
      return NextResponse.redirect(`${origin}/auth/login?error=confirmation_failed`)
    }

    // Nouvel inscrit → onboarding
    if (type === 'signup') {
      return NextResponse.redirect(`${origin}/onboarding/promise`)
    }

    // Reset password
    if (type === 'recovery') {
      return NextResponse.redirect(`${origin}/auth/reset-password`)
    }

    return NextResponse.redirect(`${origin}${next}`)
  }

  // Cas 2 : OAuth PKCE (code) — Stripe Connect, Google, etc.
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) {
      console.error('[auth/callback] exchangeCodeForSession error:', error.message)
      return NextResponse.redirect(`${origin}/auth/login?error=auth_failed`)
    }
    return NextResponse.redirect(`${origin}${next}`)
  }

  // Aucun token reconnu
  return NextResponse.redirect(`${origin}/auth/login?error=missing_token`)
}
