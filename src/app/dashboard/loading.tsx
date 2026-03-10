export default function DashboardLoading() {
  return (
    <main className="px-8 py-8 space-y-8">
      <div>
        <div className="h-7 w-48 bg-slate-200 rounded animate-pulse" />
        <div className="h-4 w-64 bg-slate-100 rounded animate-pulse mt-2" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
            <div className="h-4 w-24 bg-slate-200 rounded animate-pulse" />
            <div className="h-8 w-20 bg-slate-100 rounded animate-pulse" />
            <div className="h-3 w-32 bg-slate-100 rounded animate-pulse" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 rounded-xl bg-slate-100 animate-pulse" />
        ))}
      </div>
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <div className="h-5 w-48 bg-slate-200 rounded animate-pulse mb-4" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-4 w-full bg-slate-100 rounded animate-pulse mb-3" />
        ))}
      </div>
    </main>
  )
}
