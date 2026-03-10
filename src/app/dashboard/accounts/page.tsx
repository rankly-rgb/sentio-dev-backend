import { createSupabaseServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { formatMrr } from '@/lib/segment-queries'
import type { Account } from '@/lib/types/accounts'
import { ScoreBadge } from '@/components/ScoreBadge'
import { EmptyState } from '@/components/EmptyState'
import { Users } from 'lucide-react'

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

export default async function AccountsPage() {
  const orgId = await getProfileOrgId()
  if (!orgId) redirect('/auth/login')

  const supabase = createSupabaseServerClient()
  const { data } = await supabase
    .from('accounts')
    .select('*')
    .eq('organization_id', orgId)
    .order('mrr_cents', { ascending: false })
    .limit(10000)

  const accounts = (data ?? []) as Account[]

  const totalMrr = accounts.reduce((sum, a) => sum + (a.mrr_cents ?? 0), 0)

  return (
    <main className="px-8 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Comptes clients</h1>
          <p className="text-slate-500 mt-1">
            {accounts.length} comptes &middot; MRR total {formatMrr(totalMrr)}
          </p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {accounts.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Aucun compte"
            description="Connectez Stripe dans les paramètres pour synchroniser vos comptes clients."
            actionLabel="Configurer Stripe"
            actionHref="/dashboard/settings"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50">
                  <th className="text-left px-4 py-3 font-medium text-slate-500">ID Stripe</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-500">ID HubSpot</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-500">Plan</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-500">Intervalle</th>
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
                    <td className="px-4 py-3 capitalize text-slate-700">{a.plan_tier ?? '—'}</td>
                    <td className="px-4 py-3 text-slate-600">
                      {a.billing_interval === 'year' ? 'Annuel' : a.billing_interval === 'month' ? 'Mensuel' : '—'}
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
    </main>
  )
}
