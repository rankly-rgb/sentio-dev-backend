'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function RefreshDataButton() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const router = useRouter()

  async function handleRefresh() {
    setLoading(true)
    setResult(null)

    try {
      const resp = await fetch('/api/sync-stripe', { method: 'POST' })
      const data = await resp.json()

      if (!resp.ok) {
        setResult({ type: 'error', message: data.error ?? 'Échec de la synchronisation' })
        return
      }

      setResult({ type: 'success', message: 'Synchronisation terminée' })
      router.refresh()
    } catch {
      setResult({ type: 'error', message: 'Erreur réseau' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={handleRefresh}
        disabled={loading}
        className="px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
