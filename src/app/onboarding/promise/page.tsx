'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'

export default function OnboardingPromisePage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let attempts = 0

    async function redirect() {
      try {
        const supabase = createSupabaseBrowserClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) {
          router.replace('/auth/login')
          return
        }

        const res = await fetch(
          `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/onboarding-status`,
          { headers: { Authorization: `Bearer ${session.access_token}` } },
        )

        if (!res.ok) throw new Error('fetch failed')

        const json = await res.json()
        const step: string = json.data?.current_step ?? 'stripe'

        const routes: Record<string, string> = {
          stripe:    '/onboarding/stripe',
          import:    '/onboarding/import',
          first_win: '/onboarding/first-win',
          hubspot:   '/onboarding/hubspot',
          done:      '/dashboard',
        }

        router.replace(routes[step] ?? '/onboarding/stripe')
      } catch {
        attempts++
        if (attempts < 3) {
          setTimeout(redirect, 1000 * attempts)
        } else {
          setError('Could not load your workspace. Please refresh the page.')
        }
      }
    }

    redirect()
  }, [router])

  if (error) {
    return (
      <div className="text-center">
        <p className="text-red-400 text-sm mb-4">{error}</p>
        <button
          onClick={() => window.location.reload()}
          className="text-indigo-400 underline text-sm hover:text-indigo-300"
        >
          Refresh
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-4 py-4">
      <div className="h-8 w-8 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
      <p className="text-slate-400 text-sm">Loading your workspace…</p>
    </div>
  )
}
