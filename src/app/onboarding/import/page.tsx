'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'

const T = {
  fr: {
    title: 'Import en cours…',
    subtitle: "Nous construisons votre base de données clients.",
    steps: [
      'Import des abonnements Stripe',
      'Construction des cohortes clients',
      'Calcul des scores de santé',
    ],
    footer: "L'import prend 30 à 90 secondes. Vous pouvez quitter cette page.",
    error: 'Une erreur est survenue pendant le sync.',
    retry: 'Réessayer depuis Stripe',
  },
  en: {
    title: 'Importing data…',
    subtitle: "We're building your customer database.",
    steps: [
      'Importing Stripe subscriptions',
      'Building customer cohorts',
      'Computing health scores',
    ],
    footer: 'Import takes 30–90 seconds. You can safely leave this page.',
    error: 'An error occurred during sync.',
    retry: 'Retry from Stripe',
  },
}

type StepStatus = 'pending' | 'running' | 'done'

function StepRow({ label, status }: { label: string; status: StepStatus }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="flex-shrink-0 w-6 h-6 flex items-center justify-center">
        {status === 'done' && (
          <div className="h-6 w-6 rounded-full bg-emerald-500 flex items-center justify-center">
            <svg className="h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}
        {status === 'running' && (
          <div className="h-5 w-5 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
        )}
        {status === 'pending' && (
          <div className="h-5 w-5 rounded-full border-2 border-slate-600" />
        )}
      </div>
      <span className={`text-sm ${
        status === 'done'    ? 'text-slate-200' :
        status === 'running' ? 'text-slate-50 font-medium' :
                               'text-slate-500'
      }`}>
        {label}
      </span>
    </div>
  )
}

export default function OnboardingImportPage() {
  const router = useRouter()
  const [locale, setLocale] = useState<'fr' | 'en'>('fr')
  const [steps, setSteps] = useState<StepStatus[]>(['running', 'pending', 'pending'])
  const [syncError, setSyncError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const saved = localStorage.getItem('sentio_locale') as 'fr' | 'en' | null
    if (saved) setLocale(saved)
  }, [])

  useEffect(() => {
    elapsedRef.current = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => { if (elapsedRef.current) clearInterval(elapsedRef.current) }
  }, [])

  useEffect(() => {
    async function poll() {
      try {
        const supabase = createSupabaseBrowserClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) return

        const res = await fetch(
          `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/get-sync-status`,
          { headers: { Authorization: `Bearer ${session.access_token}` } },
        )
        if (!res.ok) return
        const json = await res.json()
        const s = json.steps ?? {}
        const status: string = json.status

        setSteps([
          s.behavioral ? 'done' : status === 'running' ? 'running' : 'pending',
          s.behavioral && !s.cohorts ? 'running' : s.cohorts ? 'done' : 'pending',
          s.cohorts && !s.scores ? 'running' : s.scores ? 'done' : 'pending',
        ])

        if (status === 'error') {
          setSyncError(json.error_message ?? null)
          if (intervalRef.current) clearInterval(intervalRef.current)
          return
        }

        if (status === 'completed' && s.scores) {
          if (intervalRef.current) clearInterval(intervalRef.current)
          setSteps(['done', 'done', 'done'])
          setTimeout(() => router.push('/onboarding/first-win'), 800)
        }
      } catch {
        // silent retry
      }
    }

    poll()
    intervalRef.current = setInterval(poll, 3000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [router])

  const t = T[locale]

  if (syncError) {
    return (
      <div className="text-center">
        <p className="text-2xl mb-2">⚠️</p>
        <p className="text-slate-50 font-semibold mb-2">{t.error}</p>
        <p className="text-red-400 text-sm mb-6">{syncError}</p>
        <button
          onClick={() => router.push('/onboarding/stripe')}
          className="text-indigo-400 underline text-sm hover:text-indigo-300"
        >
          {t.retry}
        </button>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-50 mb-1">{t.title}</h1>
        <p className="text-slate-400 text-sm">{t.subtitle}</p>
      </div>

      <div className="divide-y divide-slate-700/50 mb-6">
        {t.steps.map((label, i) => (
          <StepRow key={label} label={label} status={steps[i]} />
        ))}
      </div>

      {elapsed > 90 && steps[0] === 'running' && (
        <div className="mb-4 bg-amber-900/30 border border-amber-700/50 rounded-lg p-3">
          <p className="text-amber-400 text-xs">L&apos;import prend plus de temps que prévu. Nous continuons en arrière-plan.</p>
        </div>
      )}

      <p className="text-slate-500 text-xs text-center">{t.footer}</p>
    </div>
  )
}
