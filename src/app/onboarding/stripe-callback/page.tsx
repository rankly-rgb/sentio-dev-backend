'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { Suspense } from 'react'

function StripeCallbackInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const code = searchParams.get('code')
    const state = searchParams.get('state')

    if (!code || !state) {
      setError('Missing OAuth parameters. Please try again.')
      return
    }

    async function exchange() {
      try {
        const supabase = createSupabaseBrowserClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { router.replace('/auth/login'); return }

        const res = await fetch(
          `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/stripe-oauth-callback`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, state }),
          },
        )
        const json = await res.json()
        if (json.success || res.ok) {
          router.replace('/onboarding/import')
        } else {
          setError(json.error ?? 'Failed to connect Stripe. Please retry.')
        }
      } catch {
        setError('Network error. Please retry.')
      }
    }

    exchange()
  }, [router, searchParams])

  if (error) {
    return (
      <div className="text-center">
        <p className="text-red-400 text-sm mb-4">{error}</p>
        <button
          onClick={() => router.replace('/onboarding/stripe')}
          className="text-indigo-400 underline text-sm hover:text-indigo-300"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-4 py-4">
      <div className="h-8 w-8 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
      <p className="text-slate-400 text-sm">Finishing Stripe connection…</p>
    </div>
  )
}

export default function StripeCallbackPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-4">
        <div className="h-8 w-8 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
      </div>
    }>
      <StripeCallbackInner />
    </Suspense>
  )
}
