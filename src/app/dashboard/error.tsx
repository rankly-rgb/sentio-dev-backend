'use client'

import { useEffect } from 'react'

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[dashboard-error-boundary]', {
      message: error.message,
      digest: error.digest ?? 'unknown',
    })
  }, [error])

  return (
    <main className="px-8 py-8">
      <div className="bg-white rounded-xl border border-red-200 p-8 text-center space-y-4 max-w-lg mx-auto mt-12">
        <h2 className="text-lg font-semibold text-slate-900">
          Impossible de charger cette page
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
  )
}
