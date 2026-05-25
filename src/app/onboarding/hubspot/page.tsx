'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'

const T = {
  fr: {
    title: 'Connectez HubSpot',
    subtitle: 'Optionnel — enrichit le scoring d\'engagement',
    whatSync: 'Ce que HubSpot apporte',
    items: [
      'Scoring d\'engagement CRM',
      'Détection des signaux de désengagement',
    ],
    zeroPii: '🛡️ Push-only · Nous ne lisons jamais vos contacts',
    keyLabel: 'Token Private App HubSpot',
    keyPlaceholder: 'pat-eu1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    connect: 'Connecter HubSpot',
    connecting: 'Connexion en cours…',
    skip: 'Ignorer pour l\'instant',
    skipping: 'Redirection…',
    errFormat: 'Le token doit commencer par pat-',
    errInvalid: 'Token invalide ou permissions insuffisantes',
    errNetwork: 'Impossible de joindre HubSpot. Réessayez.',
  },
  en: {
    title: 'Connect HubSpot',
    subtitle: 'Optional — enriches engagement scoring',
    whatSync: 'What HubSpot adds',
    items: [
      'CRM engagement scoring',
      'Disengagement signal detection',
    ],
    zeroPii: '🛡️ Push-only · We never read your contacts',
    keyLabel: 'HubSpot Private App Token',
    keyPlaceholder: 'pat-eu1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    connect: 'Connect HubSpot',
    connecting: 'Connecting…',
    skip: 'Skip for now',
    skipping: 'Redirecting…',
    errFormat: 'Token must start with pat-',
    errInvalid: 'Invalid token or insufficient permissions',
    errNetwork: 'Cannot reach HubSpot. Please retry.',
  },
}

export default function OnboardingHubSpotPage() {
  const router = useRouter()
  const [locale, setLocale] = useState<'fr' | 'en'>('fr')
  const [apiKey, setApiKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [skipping, setSkipping] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const saved = localStorage.getItem('sentio_locale') as 'fr' | 'en' | null
    if (saved) setLocale(saved)
  }, [])

  async function getSession() {
    const supabase = createSupabaseBrowserClient()
    const { data: { session } } = await supabase.auth.getSession()
    return session
  }

  async function completeOnboarding(jwt: string) {
    await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/onboarding-status`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: 'onboarding_completed', value: true }),
      },
    ).catch(() => {})
  }

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const key = apiKey.trim()
    if (!key.startsWith('pat-')) {
      setError(t.errFormat)
      return
    }

    setLoading(true)
    try {
      const session = await getSession()
      if (!session) { router.replace('/auth/login'); return }

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/hubspot-connect`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ hubspot_api_key: key }),
        },
      )
      const json = await res.json()
      if (json.success) {
        // hubspot-connect already marks onboarding_completed=true
        router.push('/dashboard')
      } else {
        setError(
          json.error?.includes('invalide') || json.error?.includes('invalid')
            ? t.errInvalid
            : (json.error ?? t.errNetwork),
        )
      }
    } catch {
      setError(t.errNetwork)
    } finally {
      setLoading(false)
    }
  }

  async function handleSkip() {
    setSkipping(true)
    try {
      const session = await getSession()
      if (session) await completeOnboarding(session.access_token)
    } finally {
      router.push('/dashboard')
    }
  }

  const t = T[locale]

  return (
    <div>
      {/* Title */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="h-10 w-10 rounded-lg bg-orange-900/60 flex items-center justify-center text-xl">🔗</div>
          <div>
            <h1 className="text-xl font-bold text-slate-50">{t.title}</h1>
            <span className="text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full">{t.subtitle}</span>
          </div>
        </div>
      </div>

      {/* What HubSpot adds */}
      <div className="mb-6 bg-slate-900/60 rounded-lg p-4 border border-slate-700">
        <p className="text-slate-400 text-xs font-semibold uppercase tracking-wider mb-3">{t.whatSync}</p>
        <ul className="space-y-2">
          {t.items.map(item => (
            <li key={item} className="flex items-center gap-2 text-sm text-slate-300">
              <span className="text-emerald-400">✓</span> {item}
            </li>
          ))}
        </ul>
        <div className="mt-3 pt-3 border-t border-slate-700">
          <span className="text-xs text-emerald-400 font-medium">{t.zeroPii}</span>
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleConnect} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">{t.keyLabel}</label>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={t.keyPlaceholder}
            className="w-full bg-slate-900 border border-slate-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 text-slate-50 placeholder-slate-500 rounded-lg px-4 py-3 outline-none transition-colors font-mono text-sm"
          />
          {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
        </div>

        <button
          type="submit"
          disabled={loading || skipping}
          className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold py-3 px-6 rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          {loading && <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />}
          {loading ? t.connecting : t.connect}
        </button>
      </form>

      <div className="mt-4 text-center">
        <button
          onClick={handleSkip}
          disabled={loading || skipping}
          className="text-slate-400 hover:text-slate-200 text-sm underline transition-colors disabled:opacity-50"
        >
          {skipping ? t.skipping : t.skip}
        </button>
      </div>
    </div>
  )
}
