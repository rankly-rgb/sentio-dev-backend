'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { useOnboarding } from '../context'

const T = {
  fr: {
    title: 'Connectez Stripe',
    subtitle: 'Import en 2 minutes · Aucune donnée personnelle',
    whatSync: 'Ce que nous synchronisons',
    items: ['Abonnements (ID uniquement)', 'MRR & ARR par compte', 'Factures & statuts de paiement'],
    tabKey: 'Clé API (recommandé)',
    tabOAuth: 'Stripe Connect (OAuth)',
    keyLabel: 'Clé API Stripe restreinte',
    keyPlaceholder: 'rk_live_... ou rk_test_...',
    validate: 'Valider ma clé',
    validating: 'Validation en cours…',
    connectOAuth: 'Connecter via Stripe →',
    connectingOAuth: 'Redirection vers Stripe…',
    modeTest: 'Mode test activé',
    modeLive: 'Mode production',
    errFormat: 'La clé doit commencer par rk_live_, rk_test_, sk_live_ ou sk_test_',
    errInvalid: 'Clé invalide ou permissions insuffisantes',
    errNetwork: 'Impossible de joindre Stripe. Réessayez.',
    zeroPii: '🛡️ Zero PII — aucune donnée personnelle',
  },
  en: {
    title: 'Connect Stripe',
    subtitle: 'Import in 2 minutes · No personal data',
    whatSync: "What we'll sync",
    items: ['Subscriptions (ID only)', 'MRR & ARR per account', 'Invoices & payment status'],
    tabKey: 'API Key (recommended)',
    tabOAuth: 'Stripe Connect (OAuth)',
    keyLabel: 'Stripe restricted API key',
    keyPlaceholder: 'rk_live_... or rk_test_...',
    validate: 'Validate my key',
    validating: 'Validating…',
    connectOAuth: 'Connect via Stripe →',
    connectingOAuth: 'Redirecting to Stripe…',
    modeTest: 'Test mode',
    modeLive: 'Live mode',
    errFormat: 'Key must start with rk_live_, rk_test_, sk_live_ or sk_test_',
    errInvalid: 'Invalid key or insufficient permissions',
    errNetwork: 'Cannot reach Stripe. Please retry.',
    zeroPii: '🛡️ Zero PII — no personal data stored',
  },
}

export default function OnboardingStripePage() {
  const router = useRouter()
  const { locale } = useOnboarding()
  const t = T[locale]

  const [tab, setTab] = useState<'key' | 'oauth'>('key')
  const [apiKey, setApiKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'live' | 'test' | null>(null)

  async function getJwt() {
    const supabase = createSupabaseBrowserClient()
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }

  async function handleKeySubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setMode(null)

    const key = apiKey.trim()
    const validPrefixes = ['rk_live_', 'rk_test_', 'sk_live_', 'sk_test_']
    if (!validPrefixes.some(p => key.startsWith(p)) || key.length < 30) {
      setError(t.errFormat)
      return
    }

    setLoading(true)
    try {
      const jwt = await getJwt()
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/verify-stripe-token`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ stripe_api_key: key }),
        },
      )
      const json = await res.json()
      if (json.success) {
        setMode(json.mode)
        setTimeout(() => router.push('/onboarding/import'), 800)
      } else {
        setError(json.error === 'Clé Stripe invalide ou permissions insuffisantes'
          ? t.errInvalid : (json.error ?? t.errNetwork))
      }
    } catch {
      setError(t.errNetwork)
    } finally {
      setLoading(false)
    }
  }

  async function handleOAuth() {
    setLoading(true)
    setError(null)
    try {
      const jwt = await getJwt()
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/stripe-oauth-initiate`,
        { headers: { Authorization: `Bearer ${jwt}` } },
      )
      const json = await res.json()
      if (json.url) {
        window.location.href = json.url
      } else {
        setError(t.errNetwork)
        setLoading(false)
      }
    } catch {
      setError(t.errNetwork)
      setLoading(false)
    }
  }

  return (
    <div>
      {/* Title */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="h-10 w-10 rounded-lg bg-indigo-900 flex items-center justify-center text-xl">💳</div>
          <h1 className="text-xl font-bold text-slate-50">{t.title}</h1>
        </div>
        <p className="text-slate-400 text-sm">{t.subtitle}</p>
      </div>

      {/* What we sync */}
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

      {/* Tabs */}
      <div className="flex gap-1 bg-slate-900 rounded-lg p-1 mb-5">
        {(['key', 'oauth'] as const).map(t2 => (
          <button
            key={t2}
            onClick={() => { setTab(t2); setError(null) }}
            className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
              tab === t2 ? 'bg-slate-700 text-slate-50' : 'text-slate-400 hover:text-slate-300'
            }`}
          >
            {t2 === 'key' ? t.tabKey : t.tabOAuth}
          </button>
        ))}
      </div>

      {/* Tab: API Key */}
      {tab === 'key' && (
        <form onSubmit={handleKeySubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">{t.keyLabel}</label>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={t.keyPlaceholder}
              required
              className="w-full bg-slate-900 border border-slate-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 text-slate-50 placeholder-slate-500 rounded-lg px-4 py-3 outline-none transition-colors font-mono text-sm"
            />
            {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
            {mode && (
              <p className={`text-xs mt-2 font-medium ${mode === 'live' ? 'text-emerald-400' : 'text-amber-400'}`}>
                ✓ {mode === 'live' ? t.modeLive : t.modeTest}
              </p>
            )}
          </div>
          <button
            type="submit"
            disabled={loading || !!mode}
            className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold py-3 px-6 rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            {loading && <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />}
            {loading ? t.validating : t.validate}
          </button>
        </form>
      )}

      {/* Tab: OAuth */}
      {tab === 'oauth' && (
        <div className="space-y-4">
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <button
            onClick={handleOAuth}
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold py-3 px-6 rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            {loading && <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />}
            {loading ? t.connectingOAuth : t.connectOAuth}
          </button>
        </div>
      )}
    </div>
  )
}
