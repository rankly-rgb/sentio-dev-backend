import { Suspense } from 'react'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { RefreshDataButton } from '@/components/RefreshDataButton'
import { ScoreBadge } from '@/components/ScoreBadge'
import { SEGMENT_FILTERS, SEGMENTS, formatMrr } from '@/lib/segment-queries'
import type { Account } from '@/lib/types/accounts'
import Link from 'next/link'
import { AlertTriangle, Users, CreditCard } from 'lucide-react'

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

async function getAccounts(organizationId: string): Promise<Account[]> {
  const supabase = createSupabaseServerClient()
  const { data } = await supabase
    .from('accounts')
    .select('*')
    .eq('organization_id', organizationId)
    .limit(10000)

  return (data ?? []) as Account[]
}

export default async function DashboardPage() {
  const orgId = await getProfileOrgId()
  if (!orgId) redirect('/auth/login')

  const accounts = await getAccounts(orgId)

  const totalMrr = accounts.reduce((sum, a) => sum + (a.mrr_cents ?? 0), 0)
  const withHealth = accounts.filter((a) => a.health_score !== null)
  const avgHealth = withHealth.length > 0
    ? Math.round(withHealth.reduce((sum, a) => sum + (a.health_score ?? 0), 0) / withHealth.length)
    : null

  const atRisk = accounts.filter((a) => (a.churn_risk_score ?? 0) >= 70)
  const topAtRisk = [...atRisk]
    .sort((a, b) => (b.churn_risk_score ?? 0) - (a.churn_risk_score ?? 0))
    .slice(0, 5)

  const expansionOpps = accounts
    .filter((a) => (a.expansion_score ?? 0) >= 70 && (a.health_score ?? 0) >= 60)
    .sort((a, b) => (b.expansion_score ?? 0) - (a.expansion_score ?? 0))
    .slice(0, 5)

  const segmentCounts = SEGMENTS.slice(0, 4).map((seg) => ({
    ...seg,
    count: accounts.filter(SEGMENT_FILTERS[seg.key]).length,
  }))

  return (
    <main className="px-8 py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Vue d&apos;ensemble</h1>
          <p className="text-slate-500 mt-1">Tableau de bord de votre base client</p>
        </div>
        <RefreshDataButton />
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        <KpiCard
          icon={Users}
          label="Comptes actifs"
          value={accounts.length.toString()}
          description="Total des comptes suivis"
        />
        <KpiCard
          icon={CreditCard}
          label="MRR Total"
          value={formatMrr(totalMrr)}
          description="Revenus récurrents mensuels"
        />
        <KpiCard
          icon={AlertTriangle}
          label="Score santé moyen"
          value={avgHealth !== null ? `${avgHealth}` : '—'}
          description="Sur l'ensemble des comptes"
          variant={
            avgHealth !== null
              ? avgHealth >= 70 ? 'success' : avgHealth >= 40 ? 'warning' : 'danger'
              : 'neutral'
          }
        />
        <KpiCard
          icon={AlertTriangle}
          label="Comptes à risque"
          value={atRisk.length.toString()}
          description="Churn risk ≥ 70"
          variant={atRisk.length > 0 ? 'danger' : 'success'}
        />
      </div>

      {/* Segments quick view */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {segmentCounts.map((seg) => (
          <Link
            key={seg.key}
            href={`/dashboard/segments/${seg.key}`}
            className={`p-4 rounded-xl border ${seg.borderColor} ${seg.bgColor} hover:shadow-md transition-shadow`}
          >
            <p className={`text-xs font-medium ${seg.color}`}>{seg.label}</p>
            <p className="text-2xl font-bold text-slate-900 mt-1">{seg.count}</p>
            <p className="text-xs text-slate-500">comptes</p>
          </Link>
        ))}
      </div>

      {/* Two-column: At risk + Expansion */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-slate-900">Comptes à risque</h3>
            <Link href="/dashboard/segments/en_danger_critique" className="text-xs text-indigo-600 hover:text-indigo-700 font-medium">
              Voir tout
            </Link>
          </div>
          {topAtRisk.length === 0 ? (
            <p className="text-sm text-slate-400 py-4 text-center">Aucun compte à risque critique</p>
          ) : (
            <div className="space-y-3">
              {topAtRisk.map((account) => (
                <div key={account.id} className="flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-700 truncate">
                      {account.stripe_customer_id ?? account.id.slice(0, 8)}
                    </p>
                    <p className="text-xs text-slate-400">{formatMrr(account.mrr_cents ?? 0)}</p>
                  </div>
                  <ScoreBadge score={account.churn_risk_score} type="churn" showLabel />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-slate-900">Opportunités d&apos;expansion</h3>
            <Link href="/dashboard/segments/en_expansion" className="text-xs text-indigo-600 hover:text-indigo-700 font-medium">
              Voir tout
            </Link>
          </div>
          {expansionOpps.length === 0 ? (
            <p className="text-sm text-slate-400 py-4 text-center">Aucune opportunité détectée</p>
          ) : (
            <div className="space-y-3">
              {expansionOpps.map((account) => (
                <div key={account.id} className="flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-700 truncate">
                      {account.stripe_customer_id ?? account.id.slice(0, 8)}
                    </p>
                    <p className="text-xs text-slate-400">{formatMrr(account.mrr_cents ?? 0)}</p>
                  </div>
                  <ScoreBadge score={account.expansion_score} type="expansion" showLabel />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Syncs */}
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <h3 className="font-semibold text-slate-900 mb-4">Synchronisations récentes</h3>
        <Suspense fallback={<p className="text-sm text-slate-400">Chargement...</p>}>
          <SyncStatus organizationId={orgId} />
        </Suspense>
      </div>
    </main>
  )
}

// ── Sub-components ────────────────────────────────────────────────

interface KpiCardProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  description: string
  variant?: 'success' | 'warning' | 'danger' | 'neutral'
}

function KpiCard({ icon: Icon, label, value, description, variant = 'neutral' }: KpiCardProps) {
  const variantClass = {
    success: 'text-emerald-600',
    warning: 'text-amber-600',
    danger: 'text-red-600',
    neutral: 'text-slate-900',
  }[variant]

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-2">
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-slate-400" />
        <p className="text-sm font-medium text-slate-500">{label}</p>
      </div>
      <p className={`text-3xl font-bold ${variantClass}`}>{value}</p>
      <p className="text-xs text-slate-400">{description}</p>
    </div>
  )
}

async function SyncStatus({ organizationId }: { organizationId: string }) {
  const supabase = createSupabaseServerClient()
  const { data: syncs, error } = await supabase
    .from('data_syncs')
    .select('sync_source, sync_type, sync_status, completed_at, records_processed')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(5)

  if (error) {
    return <p className="text-sm text-slate-400">Impossible de charger les synchronisations.</p>
  }

  if (!syncs?.length) {
    return (
      <div className="text-center py-6">
        <p className="text-sm text-slate-500 mb-2">Aucune synchronisation effectuée</p>
        <p className="text-xs text-slate-400">
          Connectez Stripe dans les <Link href="/dashboard/settings" className="text-indigo-600 hover:underline">Paramètres</Link> pour commencer.
        </p>
      </div>
    )
  }

  const statusBadge = (status: string) => {
    const classes: Record<string, string> = {
      completed: 'bg-emerald-100 text-emerald-700',
      running: 'bg-blue-100 text-blue-700',
      failed: 'bg-red-100 text-red-700',
      pending: 'bg-slate-100 text-slate-600',
    }
    return classes[status] ?? 'bg-slate-100 text-slate-600'
  }

  return (
    <div className="space-y-3">
      {syncs.map((sync, i) => (
        <div key={i} className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-3">
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge(sync.sync_status)}`}>
              {sync.sync_status}
            </span>
            <span className="text-slate-700 font-medium capitalize">{sync.sync_source}</span>
            <span className="text-slate-400">{sync.sync_type}</span>
          </div>
          <div className="flex items-center gap-4 text-slate-400">
            <span>{sync.records_processed ?? 0} enregistrements</span>
            <span>
              {sync.completed_at
                ? new Date(sync.completed_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
                : '—'}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
