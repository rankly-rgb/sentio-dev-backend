'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

export function RefreshDataButton() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const router = useRouter()

  // Auto-clear result message after 5 seconds
  useEffect(() => {
    if (!result) return
    const timer = setTimeout(() => setResult(null), 5000)
    return () => clearTimeout(timer)
  }, [result])

  async function handleRefresh() {
    setLoading(true)
    setResult(null)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 65_000)

    try {
      // TEMP DEBUG — log fetch start
      const fetchStart = performance.now()
      console.error('[SENTIO_DEBUG][refresh-data]', {
        type: 'fetch_start',
        timestamp: new Date().toISOString(),
        url: '/api/sync-stripe',
      })

      const resp = await fetch('/api/sync-stripe', {
        method: 'POST',
        signal: controller.signal,
      })

      // TEMP DEBUG — log fetch end
      console.error('[SENTIO_DEBUG][refresh-data]', {
        type: 'fetch_end',
        duration_ms: Math.round(performance.now() - fetchStart),
        status: resp.status,
        timestamp: new Date().toISOString(),
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

      setResult({ type: 'success', message: 'Synchronisation lancée' })
      router.refresh()
    } catch (err) {
      // TEMP DEBUG — log fetch error
      console.error('[SENTIO_DEBUG][refresh-data]', {
        type: 'fetch_error',
        message: err instanceof Error ? err.message : String(err),
        name: err instanceof DOMException ? err.name : undefined,
        timestamp: new Date().toISOString(),
      })

      if (err instanceof DOMException && err.name === 'AbortError') {
        setResult({ type: 'error', message: 'Délai d\'attente dépassé' })
      } else {
        setResult({ type: 'error', message: 'Erreur réseau' })
      }
    } finally {
      clearTimeout(timeout)
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={handleRefresh}
        disabled={loading}
        aria-label="Actualiser les données de synchronisation Stripe"
        className="px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
      >
        {loading ? 'Synchronisation...' : 'Actualiser les données'}
      </button>
      {result && (
        <span
          className={`text-sm ${result.type === 'success' ? 'text-emerald-600' : 'text-red-600'}`}
        >
          {result.message}
        </span>
      )}
    </div>
  )
}
