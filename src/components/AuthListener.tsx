'use client'

import { type ReactElement, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'

/**
 * Listens to Supabase auth state changes and keeps
 * Server Components in sync by calling router.refresh()
 * when the token is refreshed (new cookie written).
 * Redirects to login on sign-out.
 */
export function AuthListener(): ReactElement | null {
  const router = useRouter()

  useEffect(() => {
    const supabase = createSupabaseBrowserClient()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_OUT') {
        router.refresh()
      }
      if (event === 'SIGNED_OUT') {
        router.push('/auth/login')
      }
    })

    return () => subscription.unsubscribe()
  }, [router])

  return null
}
