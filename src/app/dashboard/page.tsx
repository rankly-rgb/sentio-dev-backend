import { createSupabaseServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { RefreshDataButton } from '@/components/RefreshDataButton'

interface DashboardStats {
  total_accounts: number
  total_mrr_cents: number
  avg_health_score: number | null
  accounts_at_risk: number
  champions_count: number
}

async function getDashboardStats(organizationId: string): Promise<DashboardStats> {
  const supabase = createSupabaseServerClient()

  const { data: accounts } = await supabase
    .from('accounts')
    .select('id, mrr_cents, health_score, churn_risk_score')
    .eq('organization_id', organizationId)

  if (!accounts || accounts.length === 0) {
    return {
      total_accounts: 0,
      total_mrr_cents: 0,
      avg_health_score: null,
      accounts_at_risk: 0,
      champions_count: 0,
    }
  }

  const totalMrr = accounts.reduce((sum, a) => sum + (a.mrr_cents ?? 0), 0)
  const withHealth = accounts.filter((a) => a.health_score !== null)
  const avgHealth =
    withHealth.length > 0
      ? withHealth.reduce((sum, a) => sum + (a.health_score ?? 0), 0) / withHealth.length
      : null

  const atRisk = accounts.filter((a) => (a.churn_risk_score ?? 0) >= 70).length
  const champions = accounts.filter((a) => (a.health_score ?? 0) >= 80).length

  return {
    total_accounts: accounts.length,
    total_mrr_cents: totalMrr,
    avg_health_score: avgHealth ? Math.round(avgHealth * 10) / 10 : null,
    accounts_at_risk: atRisk,
    champions_count: champions,
  }
}

function formatMrr(cents: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0,
  }).format(cents / 100)
}

export default async function DashboardPage() {
  const supabase = createSupabaseServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: profile } = await supabase
    .from('profiles_')
    .select('organization_id, role, full_name')
    .eq('auth_user_id', user.id)
    .single()

  if (!profile?.organization_id) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-slate-500">Aucune organisation associée à ce compte.</p>
      </div>
    )
  }

  const stats = await getDashboardStats(profile.organization_id)

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <h1 className="text-xl font-bold text-slate-900">Sentio AI</h1>
          <span className="text-sm text-slate-500">
            {profile.full_name ?? user.email}
          </span>
        </div>
      </header>

      {/* Dashboard */}
      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Dashboard</h2>
          <p className="text-slate-500 mt-1">Vue d&apos;ensemble de votre base client</p>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <KpiCard
            label="Comptes actifs"
            value={stats.total_accounts.toString()}
            description="Total des comptes suivis"
          />
          <KpiCard
            label="MRR Total"
            value={formatMrr(stats.total_mrr_cents)}
            description="Revenus récurrents mensuels"
          />
          <KpiCard
            label="Health Score moyen"
            value={stats.avg_health_score !== null ? `${stats.avg_health_score}/100` : '—'}
            description="Score de santé moyen"
            variant={
              stats.avg_health_score !== null
                ? stats.avg_health_score >= 70
                  ? 'success'
                  : stats.avg_health_score >= 40
                  ? 'warning'
                  : 'danger'
                : 'neutral'
            }
          />
          <KpiCard
            label="Comptes à risque"
            value={stats.accounts_at_risk.toString()}
            description="Churn risk ≥ 70%"
            variant={stats.accounts_at_risk > 0 ? 'danger' : 'success'}
          />
        </div>

        {/* État sync */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-slate-900">Synchronisations récentes</h3>
            <RefreshDataButton />
          </div>
          <SyncStatus organizationId={profile.organization_id} />
        </div>
      </main>
    </div>
  )
}

// ── Composants ────────────────────────────────────────────────
interface KpiCardProps {
  label: string
  value: string
  description: string
  variant?: 'success' | 'warning' | 'danger' | 'neutral'
}

function KpiCard({ label, value, description, variant = 'neutral' }: KpiCardProps) {
  const variantClass = {
    success: 'text-emerald-600',
    warning: 'text-amber-600',
    danger: 'text-red-600',
    neutral: 'text-slate-900',
  }[variant]

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-2">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className={`text-3xl font-bold ${variantClass}`}>{value}</p>
      <p className="text-xs text-slate-400">{description}</p>
    </div>
  )
}

async function SyncStatus({ organizationId }: { organizationId: string }) {
  const supabase = createSupabaseServerClient()
  const { data: syncs } = await supabase
    .from('data_syncs')
    .select('sync_source, sync_type, sync_status, completed_at, records_processed')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(5)

  if (!syncs?.length) {
    return (
      <p className="text-sm text-slate-400">
        Aucune synchronisation effectuée. Lancez votre premier sync Stripe.
      </p>
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
                ? new Date(sync.completed_at).toLocaleString('fr-FR', {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })
                : '—'}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
