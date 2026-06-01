'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { RefreshCw, Calculator } from 'lucide-react'

interface SyncButtonsProps {
  hubspotConnected: boolean
}

type SyncAction = 'stripe-incremental' | 'stripe-full' | 'hubspot' | 'scores'

export function SyncButtons({ hubspotConnected }: SyncButtonsProps) {
  const [loading, setLoading] = useState<SyncAction | null>(null)
  const [result, setResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const router = useRouter()

  useEffect(() => {
    if (!result) return
    const timer = setTimeout(() => setResult(null), 5000)
    return () => clearTimeout(timer)
  }, [result])

  async function handleSync(action: SyncAction) {
    setLoading(action)
    setResult(null)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 65_000)

    try {
      let url: string
      let body: Record<string, unknown> | undefined

      switch (action) {
        case 'stripe-incremental':
          url = '/api/sync-stripe'
          break
        case 'stripe-full':
          url = '/api/sync-stripe'
          body = { sync_type: 'full_sync' }
          break
        case 'hubspot':
          url = '/api/sync-hubspot'
          break
        case 'scores':
          url = '/api/sync-stripe'
          body = { action: 'calculate-scores' }
          break
      }

      const resp = await fetch(url, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })

      let data
      try {
        data = await resp.json()
      } catch {
        setResult({ type: 'error', message: 'Réponse invalide du serveur' })
        return
      }

      if (!resp.ok) {
        setResult({ type: 'error', message: data.error ?? 'Échec de la synchronisation' })
        return
      }

      const labels: Record<SyncAction, string> = {
        'stripe-incremental': 'Sync Stripe lancée',
        'stripe-full': 'Sync Stripe complète lancée',
        'hubspot': 'Sync HubSpot lancée',
        'scores': 'Recalcul des scores lancé',
      }
      setResult({ type: 'success', message: labels[action] })
      router.refresh()
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setResult({ type: 'error', message: 'Délai d\'attente dépassé' })
      } else {
        setResult({ type: 'error', message: 'Erreur réseau' })
      }
    } finally {
      clearTimeout(timeout)
      setLoading(null)
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <SyncButton
          label="Sync Stripe incrémental"
          loadingLabel="Sync Stripe..."
          onClick={() => handleSync('stripe-incremental')}
          disabled={loading !== null}
          loading={loading === 'stripe-incremental'}
          icon={<RefreshCw className="w-4 h-4" />}
        />
        <SyncButton
          label="Sync Stripe complet"
          loadingLabel="Sync Stripe..."
          onClick={() => handleSync('stripe-full')}
          disabled={loading !== null}
          loading={loading === 'stripe-full'}
          icon={<RefreshCw className="w-4 h-4" />}
        />
        {hubspotConnected && (
          <SyncButton
            label="Sync HubSpot"
            loadingLabel="Sync HubSpot..."
            onClick={() => handleSync('hubspot')}
            disabled={loading !== null}
            loading={loading === 'hubspot'}
            icon={<RefreshCw className="w-4 h-4" />}
            variant="orange"
          />
        )}
        <SyncButton
          label="Recalculer les scores"
          loadingLabel="Calcul..."
          onClick={() => handleSync('scores')}
          disabled={loading !== null}
          loading={loading === 'scores'}
          icon={<Calculator className="w-4 h-4" />}
          variant="indigo"
        />
      </div>
      {result && (
        <span className={`text-sm ${result.type === 'success' ? 'text-emerald-600' : 'text-red-600'}`}>
          {result.message}
        </span>
      )}
    </div>
  )
}

function SyncButton({
  label,
  loadingLabel,
  onClick,
  disabled,
  loading,
  icon,
  variant = 'default',
}: {
  label: string
  loadingLabel: string
  onClick: () => void
  disabled: boolean
  loading: boolean
  icon: React.ReactNode
  variant?: 'default' | 'indigo' | 'orange'
}) {
  const styles = {
    default: 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50',
    indigo: 'bg-indigo-600 text-white hover:bg-indigo-700',
    orange: 'bg-orange-500 text-white hover:bg-orange-600',
  }

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${styles[variant]}`}
    >
      {loading ? (
        <RefreshCw className="w-4 h-4 animate-spin" />
      ) : (
        icon
      )}
      {loading ? loadingLabel : label}
    </button>
  )
}
