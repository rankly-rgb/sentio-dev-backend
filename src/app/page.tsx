import Link from 'next/link'

export default function HomePage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-8 px-4">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold text-slate-900">Sentio AI</h1>
        <p className="text-lg text-slate-500">
          Customer Intelligence & Retention Analytics pour SaaS B2B
        </p>
      </div>
      <div className="flex gap-4">
        <Link
          href="/dashboard"
          className="px-6 py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors"
        >
          Accéder au dashboard
        </Link>
        <Link
          href="/auth/login"
          className="px-6 py-3 bg-white border border-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-50 transition-colors"
        >
          Se connecter
        </Link>
      </div>
    </main>
  )
}
