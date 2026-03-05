'use client'

import { useEffect } from 'react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  // TEMP DEBUG — enriched error logging for freeze diagnosis
  useEffect(() => {
    console.error('[SENTIO_DEBUG][global-error-boundary]', {
      type: 'error_boundary',
      boundary: 'global',
      message: error.message,
      stack: error.stack,
      digest: error.digest ?? 'unknown',
      timestamp: new Date().toISOString(),
      url: typeof window !== 'undefined' ? window.location.href : 'ssr',
    })
  }, [error])

  return (
    <html lang="fr">
      <body className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center space-y-4 max-w-md px-6">
          <h2 className="text-xl font-bold text-slate-900">Erreur critique</h2>
          <p className="text-sm text-slate-500">
            L&apos;application a rencontré un problème inattendu.
          </p>
          <button
            onClick={reset}
            className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 transition-colors"
          >
            Recharger
          </button>
        </div>
      </body>
    </html>
  )
}
