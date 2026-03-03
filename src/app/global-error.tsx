'use client'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
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
