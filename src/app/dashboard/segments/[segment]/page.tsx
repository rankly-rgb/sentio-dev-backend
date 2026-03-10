import { createSupabaseServerClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import { SEGMENT_FILTERS, getSegmentMeta, formatMrr } from '@/lib/segment-queries'
import type { SegmentKey } from '@/lib/segment-queries'
import type { Account } from '@/lib/types/accounts'
import { ScoreBadge } from '@/components/ScoreBadge'
import { Breadcrumbs } from '@/components/Breadcrumbs'
import { EmptyState } from '@/components/EmptyState'
import { Download, Users } from 'lucide-react'
import Link from 'next/link'

interface PageProps {
  params: { segment: string }
}

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

export default async function SegmentDetailPage({ params }: PageProps) {
  const segmentKey = params.segment as SegmentKey
  const meta = getSegmentMeta(segmentKey)
  if (!meta) notFound()

  const orgId = await getProfileOrgId()
  if (!orgId) redirect('/auth/login')

  const filter = SEGMENT_FILTERS[segmentKey]
  if (!filter) notFound()

  const supabase = createSupabaseServerClient()
  const { data } = await supabase
    .from('accounts')
    .select('*')
    .eq('organization_id', orgId)
    .order('mrr_cents', { ascending: false })
    .limit(10000)

  const allAccounts = (data ?? []) as Account[]
  const accounts = allAccounts.filter(filter)

  const totalMrr = accounts.reduce((sum, a) => sum + (a.mrr_cents ?? 0), 0)
  const withHealth = accounts.filter((a) => a.health_score !== null)
  const avgHealth = withHealth.length > 0
    ? Math.round(withHealth.reduce((s, a) => s + (a.health_score ?? 0), 0) / withHealth.length)
    : null

  return (
    <main className="px-8 py-8 space-y-6">
      {/* Breadcrumbs */}
      <Breadcrumbs
        items={[
          { label: 'Segments', href: '/dashboard/segments' },
          { label: meta.label },
        ]}
      />

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-slate-900">{meta.label}</h1>
            <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${meta.bgColor} ${meta.color}`}>
              {meta.label}
            </span>
          </div>
          <p className="text-slate-500 text-sm">
            {accounts.length} comptes &middot; MRR {formatMrr(totalMrr)} &middot; Score santé moyen{' '}
            {avgHealth !== null ? avgHealth : '—'}
          </p>
        </div>
        <ExportButton segment={segmentKey} />
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <p className="text-xs text-slate-400 mb-1">comptes</p>
          <p className="text-2xl font-bold text-slate-900">{accounts.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <p className="text-xs text-slate-400 mb-1">MRR</p>
          <p className="text-2xl font-bold text-slate-900">{formatMrr(totalMrr)}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <p className="text-xs text-slate-400 mb-1">Score santé moyen</p>
          {avgHealth !== null ? (
            <ScoreBadge score={avgHealth} type="health" size="md" showLabel />
          ) : (
            <p className="text-2xl font-bold text-slate-400">—</p>
          )}
        </div>
      </div>

      {/* Accounts table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {accounts.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Aucun compte dans ce segment"
            description={`Aucun compte ne correspond aux critères du segment "${meta.label}" pour le moment.`}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50">
                  <th className="text-left px-4 py-3 font-medium text-slate-500">ID Stripe</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-500">ID HubSpot</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-500">Plan</th>
                  <th className="text-right px-4 py-3 font-medium text-slate-500">MRR</th>
                  <th className="text-center px-4 py-3 font-medium text-slate-500">Sièges</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-500">Renouvellement</th>
                  <th className="text-center px-4 py-3 font-medium text-slate-500">Santé</th>
                  <th className="text-center px-4 py-3 font-medium text-slate-500">Risque</th>
                  <th className="text-center px-4 py-3 font-medium text-slate-500">Expansion</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {accounts.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-slate-700">
                      {a.stripe_customer_id ?? '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">
                      {a.hubspot_company_id ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className="capitalize text-slate-700">{a.plan_tier ?? '—'}</span>
                      {a.billing_interval && (
                        <span className="text-xs text-slate-400 ml-1">
                          ({a.billing_interval === 'year' ? 'annuel' : 'mensuel'})
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-slate-900">
                      {formatMrr(a.mrr_cents ?? 0)}
                    </td>
                    <td className="px-4 py-3 text-center text-slate-600">
                      {a.seat_count !== null ? (
                        <span>{a.seat_count}{a.seat_limit ? `/${a.seat_limit}` : ''}</span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {a.contract_end_date
                        ? new Date(a.contract_end_date).toLocaleDateString('fr-FR')
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <ScoreBadge score={a.health_score} type="health" />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <ScoreBadge score={a.churn_risk_score} type="churn" />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <ScoreBadge score={a.expansion_score} type="expansion" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Zero-PII notice */}
      <p className="text-xs text-slate-400 text-center">
        Export Zero-PII — identifiants techniques uniquement (stripe_customer_id, hubspot_company_id)
      </p>
    </main>
  )
}

function ExportButton({ segment }: { segment: string }) {
  const exportUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/export-segment-csv?segment=${segment}`

  return (
    <a
      href={exportUrl}
      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-colors"
      download
    >
      <Download className="w-4 h-4" />
      Exporter CSV
    </a>
  )
}
