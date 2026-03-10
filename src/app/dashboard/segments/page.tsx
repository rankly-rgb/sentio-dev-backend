import { createSupabaseServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { SEGMENTS, SEGMENT_FILTERS, formatMrr } from '@/lib/segment-queries'
import type { Account } from '@/lib/types/accounts'
import { ScoreBadge } from '@/components/ScoreBadge'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

async function getProfileOrgId(): Promise<string | null> {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase
    .from('profiles_')
    .select('organization_id')
    .eq('auth_user_id', user.id)
    .maybeSingle()
  return profile?.organization_id ?? null
}

export default async function SegmentsPage() {
  const orgId = await getProfileOrgId()
  if (!orgId) redirect('/auth/login')

  const supabase = createSupabaseServerClient()
  const { data } = await supabase
    .from('accounts')
    .select('*')
    .eq('organization_id', orgId)
    .limit(10000)

  const accounts = (data ?? []) as Account[]

  const segmentData = SEGMENTS.map((seg) => {
    const filtered = accounts.filter(SEGMENT_FILTERS[seg.key])
    const totalMrr = filtered.reduce((sum, a) => sum + (a.mrr_cents ?? 0), 0)
    const withHealth = filtered.filter((a) => a.health_score !== null)
    const avgHealth = withHealth.length > 0
      ? Math.round(withHealth.reduce((s, a) => s + (a.health_score ?? 0), 0) / withHealth.length)
      : null

    return { ...seg, count: filtered.length, totalMrr, avgHealth }
  })

  return (
    <main className="px-8 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Segments clients</h1>
        <p className="text-slate-500 mt-1">{accounts.length} comptes au total</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">
        {segmentData.map((seg) => (
          <Link
            key={seg.key}
            href={`/dashboard/segments/${seg.key}`}
            className={`group bg-white rounded-xl border ${seg.borderColor} p-6 hover:shadow-md transition-all`}
          >
            <div className="flex items-center justify-between mb-3">
              <span className={`text-sm font-semibold ${seg.color}`}>{seg.label}</span>
              <ArrowRight className="w-4 h-4 text-slate-300 group-hover:text-slate-500 transition-colors" />
            </div>

            <p className="text-3xl font-bold text-slate-900">{seg.count}</p>
            <p className="text-xs text-slate-400 mb-4">comptes</p>

            <div className="flex items-center justify-between text-sm">
              <div>
                <p className="text-slate-400 text-xs">MRR</p>
                <p className="font-medium text-slate-700">{formatMrr(seg.totalMrr)}</p>
              </div>
              <div className="text-right">
                <p className="text-slate-400 text-xs">Santé moy.</p>
                <ScoreBadge score={seg.avgHealth} type="health" />
              </div>
            </div>
          </Link>
        ))}
      </div>
    </main>
  )
}
