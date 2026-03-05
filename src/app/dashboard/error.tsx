'use client'

import { useEffect } from 'react'

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  // TEMP DEBUG — enriched error logging for freeze diagnosis
  useEffect(() => {
    console.error('[SENTIO_DEBUG][dashboard-error-boundary]', {
      type: 'error_boundary',
      boundary: 'dashboard',
      message: error.message,
      stack: error.stack,
      digest: error.digest ?? 'unknown',
      timestamp: new Date().toISOString(),
      url: typeof window !== 'undefined' ? window.location.href : 'ssr',
    })
  }, [error])

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-xl font-bold text-slate-900">Sentio AI</h1>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="bg-white rounded-xl border border-red-200 p-8 text-center space-y-4">
          <h2 className="text-lg font-semibold text-slate-900">
            Impossible de charger le dashboard
          </h2>
          <p className="text-sm text-slate-500">
            {error.digest
              ? `Référence : ${error.digest}`
              : 'Une erreur est survenue lors du chargement des données.'}
          </p>
          <button
            onClick={reset}
            className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 transition-colors"
          >
            Réessayer
          </button>
        </div>
      </main>
    </div>
  )
}
