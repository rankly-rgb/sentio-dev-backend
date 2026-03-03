export default function DashboardLoading() {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <h1 className="text-xl font-bold text-slate-900">Sentio AI</h1>
          <div className="h-4 w-32 bg-slate-200 rounded animate-pulse" />
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        <div>
          <div className="h-7 w-48 bg-slate-200 rounded animate-pulse" />
          <div className="h-4 w-64 bg-slate-100 rounded animate-pulse mt-2" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-slate-200 p-6 space-y-3">
              <div className="h-4 w-24 bg-slate-200 rounded animate-pulse" />
              <div className="h-8 w-20 bg-slate-100 rounded animate-pulse" />
              <div className="h-3 w-32 bg-slate-100 rounded animate-pulse" />
            </div>
          ))}
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="h-5 w-48 bg-slate-200 rounded animate-pulse mb-4" />
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-4 w-full bg-slate-100 rounded animate-pulse mb-3" />
          ))}
        </div>
      </main>
    </div>
  )
}
