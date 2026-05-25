'use client'

import { useCallback, useEffect, useState } from 'react'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { OnboardingContext, type WizardStep } from './context'

const DEFAULT_STEPS: WizardStep[] = [
  { id: 'stripe',    label_fr: 'Connecter Stripe',   label_en: 'Connect Stripe',  required: true,  status: 'active'  },
  { id: 'import',    label_fr: 'Import des données',  label_en: 'Import data',     required: true,  status: 'pending' },
  { id: 'first_win', label_fr: 'Premier insight',     label_en: 'First insight',   required: true,  status: 'pending' },
  { id: 'hubspot',   label_fr: 'Connecter HubSpot',   label_en: 'Connect HubSpot', required: false, status: 'pending' },
]

function StepIcon({ status, index }: { status: WizardStep['status']; index: number }) {
  if (status === 'completed') {
    return (
      <div className="h-9 w-9 rounded-full bg-emerald-500 flex items-center justify-center flex-shrink-0">
        <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
    )
  }
  if (status === 'active') {
    return (
      <div className="h-9 w-9 rounded-full bg-indigo-600 border-2 border-indigo-400 flex items-center justify-center flex-shrink-0 ring-4 ring-indigo-900">
        <span className="text-white text-sm font-bold">{index + 1}</span>
      </div>
    )
  }
  return (
    <div className="h-9 w-9 rounded-full bg-slate-700 border-2 border-slate-600 flex items-center justify-center flex-shrink-0">
      <span className="text-slate-400 text-sm font-medium">{index + 1}</span>
    </div>
  )
}

function Stepper({ steps, locale }: { steps: WizardStep[]; locale: 'fr' | 'en' }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-10 px-4">
      {steps.map((step, i) => (
        <div key={step.id} className="flex items-center">
          <div className="flex flex-col items-center gap-2">
            <StepIcon status={step.status} index={i} />
            <span className={`text-xs font-medium text-center max-w-[80px] leading-tight hidden sm:block ${
              step.status === 'completed' ? 'text-emerald-400' :
              step.status === 'active'    ? 'text-indigo-300' :
                                           'text-slate-500'
            }`}>
              {locale === 'en' ? step.label_en : step.label_fr}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div className={`h-0.5 w-12 sm:w-20 mx-1 sm:mx-2 mb-5 ${
              step.status === 'completed' ? 'bg-emerald-500' : 'bg-slate-700'
            }`} />
          )}
        </div>
      ))}
    </div>
  )
}

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const [wizardSteps, setWizardSteps] = useState<WizardStep[]>(DEFAULT_STEPS)
  const [locale, setLocale] = useState<'fr' | 'en'>('fr')
  const [currentStep, setCurrentStep] = useState('stripe')
  const [stripeConnected, setStripeConnected] = useState(false)
  const [hubspotConnected, setHubspotConnected] = useState(false)
  const [firstScoreCalculated, setFirstScoreCalculated] = useState(false)
  const [ahaMomentSeen, setAhaMomentSeen] = useState(false)
  const [onboardingCompleted, setOnboardingCompleted] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const supabase = createSupabaseBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/onboarding-status`,
        { headers: { Authorization: `Bearer ${session.access_token}` } },
      )
      if (!res.ok) return
      const json = await res.json()
      const d = json.data

      const savedLocale = typeof window !== 'undefined'
        ? (localStorage.getItem('sentio_locale') as 'fr' | 'en' | null)
        : null

      setWizardSteps(d.wizard_steps ?? DEFAULT_STEPS)
      setLocale(savedLocale ?? 'fr')
      setCurrentStep(d.current_step)
      setStripeConnected(d.stripe_connected)
      setHubspotConnected(d.hubspot_connected)
      setFirstScoreCalculated(d.first_score_calculated)
      setAhaMomentSeen(d.aha_moment_seen)
      setOnboardingCompleted(d.onboarding_completed)
    } catch {
      // silent
    }
  }, [])

  useEffect(() => { fetchStatus() }, [fetchStatus])

  const ctx = {
    wizardSteps, locale, currentStep,
    stripeConnected, hubspotConnected, firstScoreCalculated,
    ahaMomentSeen, onboardingCompleted,
    refresh: fetchStatus,
  }

  return (
    <OnboardingContext.Provider value={ctx}>
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center px-4 py-12">
        <div className="mb-8 text-center">
          <p className="text-slate-400 text-sm font-semibold tracking-widest uppercase">Sentio AI</p>
        </div>
        <div className="w-full max-w-2xl">
          <Stepper steps={wizardSteps} locale={locale} />
        </div>
        <div className="w-full max-w-lg bg-slate-800 border border-slate-700 rounded-xl p-8 shadow-2xl">
          {children}
        </div>
      </div>
    </OnboardingContext.Provider>
  )
}
