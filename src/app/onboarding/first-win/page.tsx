'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'

interface AtRiskAccount {
  stripe_customer_id: string
  display_name: string | null
  health_score: number
  churn_risk: number
  mrr: number
  top_risk_reason: string
}

interface FirstWinData {
  total_accounts: number
  at_risk_accounts: AtRiskAccount[]
  mrr_at_risk: number
  global_health_score: number
}

const T = {
  fr: {
    title: '🎯 Votre radar est prêt',
    mrrAtRisk: 'de MRR à risque',
    healthScore: 'Score de santé global',
    atRisk: 'Comptes à surveiller',
    churn: 'risque churn',
    mrr: 'MRR',
    demoNote: 'Ces données sont issues de vos comptes démo — connectez vos vrais comptes pour voir votre situation réelle.',
    cta: 'Voir tous mes comptes →',
    loading: 'Analyse en cours…',
    errRetry: 'Erreur de chargement.',
    retry: 'Réessayer',
  },
  en: {
    title: '🎯 Your radar is ready',
    mrrAtRisk: 'MRR at risk',
    healthScore: 'Global health score',
    atRisk: 'Accounts to watch',
    churn: 'churn risk',
    mrr: 'MRR',
    demoNote: 'This data comes from your demo accounts — connect your real data to see your actual situation.',
    cta: 'View all accounts →',
    loading: 'Analyzing…',
    errRetry: 'Loading error.',
    retry: 'Retry',
  },
}

function healthColor(score: number) {
  if (score >= 70) return 'text-emerald-400'
  if (score >= 40) return 'text-amber-400'
  return 'text-red-400'
}

function healthBg(score: number) {
  if (score >= 70) return 'bg-emerald-900/40 border-emerald-700/50'
  if (score >= 40) return 'bg-amber-900/40 border-amber-700/50'
  return 'bg-red-900/40 border-red-700/50'
}

function formatMrr(cents: number, locale: 'fr' | 'en') {
  const euros = cents / 100
  return locale === 'en'
    ? `$${euros.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : `${euros.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} €`
}

export default function OnboardingFirstWinPage() {
  const router = useRouter()
  const [locale, setLocale] = useState<'fr' | 'en'>('fr')
  const [data, setData] = useState<FirstWinData | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [navigating, setNavigating] = useState(false)

  useEffect(() => {
    const saved = localStorage.getItem('sentio_locale') as 'fr' | 'en' | null
    if (saved) setLocale(saved)
  }, [])

  useEffect(() => {
    async function load() {
      try {
        const supabase = createSupabaseBrowserClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { router.replace('/auth/login'); return }

        const res = await fetch(
          `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/onboarding-first-win`,
          { headers: { Authorization: `Bearer ${session.access_token}` } },
        )
        if (!res.ok) throw new Error()
        const json = await res.json()
        setData(json.data)
      } catch {
        setLoadError(true)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [router])

  async function handleCta() {
    setNavigating(true)
    try {
      const supabase = createSupabaseBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        fetch(
          `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/onboarding-status`,
          {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ field: 'first_win_seen', value: true }),
          },
        ).catch(() => {})
      }
    } finally {
      router.push('/onboarding/hubspot')
    }
  }

  const t = T[locale]

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-4 py-4">
        <div className="h-8 w-8 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
        <p className="text-slate-400 text-sm">{t.loading}</p>
      </div>
    )
  }

  if (loadError || !data) {
    return (
      <div className="text-center">
        <p className="text-slate-400 text-sm mb-3">{t.errRetry}</p>
        <button onClick={() => window.location.reload()} className="text-indigo-400 underline text-sm">{t.retry}</button>
      </div>
    )
  }

  const isDemo = data.total_accounts <= 4

  return (
    <div>
      <h1 className="text-xl font-bold text-slate-50 mb-5">{t.title}</h1>

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-red-400">{formatMrr(data.mrr_at_risk, locale)}</p>
          <p className="text-xs text-red-300/70 mt-1">{t.mrrAtRisk}</p>
        </div>
        <div className={`border rounded-lg p-4 text-center ${healthBg(data.global_health_score)}`}>
          <p className={`text-2xl font-bold ${healthColor(data.global_health_score)}`}>
            {data.global_health_score}<span className="text-base font-normal">/100</span>
          </p>
          <p className="text-xs text-slate-400 mt-1">{t.healthScore}</p>
        </div>
      </div>

      {/* At-risk accounts */}
      {data.at_risk_accounts.length > 0 && (
        <div className="mb-6">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">{t.atRisk}</p>
          <div className="space-y-2">
            {data.at_risk_accounts.slice(0, 3).map((acc, i) => (
              <div key={i} className="bg-slate-900/60 border border-slate-700 rounded-lg p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-slate-200 truncate">
                    {acc.display_name ?? acc.stripe_customer_id}
                  </span>
                  <span className="text-xs text-slate-400 flex-shrink-0 ml-2">
                    {formatMrr(acc.mrr, locale)} {t.mrr}
                  </span>
                </div>
                <div className="flex items-center gap-3 mb-1">
                  <span className={`text-xs font-medium ${healthColor(acc.health_score)}`}>
                    ❤ {acc.health_score}
                  </span>
                  <span className="text-xs text-red-400">⚠ {acc.churn_risk}% {t.churn}</span>
                </div>
                <p className="text-xs text-slate-500 italic">{acc.top_risk_reason}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {isDemo && (
        <p className="text-xs text-slate-500 text-center mb-5 italic">{t.demoNote}</p>
      )}

      <button
        onClick={handleCta}
        disabled={navigating}
        className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold py-3 px-6 rounded-lg transition-colors flex items-center justify-center gap-2"
      >
        {navigating && <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />}
        {t.cta}
      </button>
    </div>
  )
}
