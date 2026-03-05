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
    // TEMP DEBUG — log auth listener lifecycle
    console.error('[SENTIO_DEBUG][auth-listener]', {
      type: 'mount',
      timestamp: new Date().toISOString(),
      url: window.location.href,
    })

    const supabase = createSupabaseBrowserClient()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      // TEMP DEBUG — log every auth state change
      console.error('[SENTIO_DEBUG][auth-state-change]', {
        type: 'auth_event',
        event,
        timestamp: new Date().toISOString(),
        url: window.location.href,
      })

      if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_OUT') {
        router.refresh()
      }
      if (event === 'SIGNED_OUT') {
        router.push('/auth/login')
      }
    })

    return () => {
      // TEMP DEBUG
      console.error('[SENTIO_DEBUG][auth-listener]', {
        type: 'unmount',
        timestamp: new Date().toISOString(),
      })
      subscription.unsubscribe()
    }
  }, [router])

  return null
}
