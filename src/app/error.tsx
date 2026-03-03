'use client'

import { useEffect } from 'react'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[app error boundary]', error)
  }, [error])

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center space-y-4 max-w-md px-6">
        <h2 className="text-xl font-bold text-slate-900">Une erreur est survenue</h2>
        <p className="text-sm text-slate-500">
          {error.digest
            ? `Référence : ${error.digest}`
            : 'Veuillez réessayer ou contacter le support si le problème persiste.'}
        </p>
        <button
          onClick={reset}
          className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 transition-colors"
        >
          Réessayer
        </button>
      </div>
    </div>
  )
}
