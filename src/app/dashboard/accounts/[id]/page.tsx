import { createSupabaseServerClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import { formatMrr } from '@/lib/segment-queries'
import { ScoreBadge } from '@/components/ScoreBadge'
import { Breadcrumbs } from '@/components/Breadcrumbs'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import type { Account } from '@/lib/types/accounts'

interface HubSpotCompany {
  hubspot_company_id: string
  lifecycle_stage: string | null
  open_deal_count: number | null
  open_ticket_count: number | null
  last_meeting_date: string | null
  last_synced_at: string | null
}

async function getOrgId(): Promise<string | null> {
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

function formatLifecycleStage(stage: string | null): string {
  if (!stage) return '—'
  const labels: Record<string, string> = {
    subscriber: 'Abonné',
    customer: 'Client',
    evangelist: 'Évangéliste',
    other: 'Autre',
  }
  return labels[stage] ?? stage
}

function daysAgo(dateStr: string | null): string {
  if (!dateStr) return '—'
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000)
  if (diff === 0) return "Aujourd\u2019hui"
  if (diff === 1) return 'Hier'
  return `il y a ${diff} jours`
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6">
      <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">{title}</h2>
      {children}
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
      <span className="text-sm text-slate-500">{label}</span>
      <span className="text-sm font-medium text-slate-900">{value}</span>
    </div>
  )
}

export default async function AccountDetailPage({ params }: { params: { id: string } }) {
  const orgId = await getOrgId()
  if (!orgId) redirect('/auth/login')

  const supabase = createSupabaseServerClient()

  const { data: account } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', params.id)
    .eq('organization_id', orgId)
    .maybeSingle()

  if (!account) notFound()

  const a = account as Account

  const { data: hsData } = await supabase
    .from('hubspot_companies')
    .select('hubspot_company_id, lifecycle_stage, open_deal_count, open_ticket_count, last_meeting_date, last_synced_at')
    .eq('organization_id', orgId)
    .eq('account_id', params.id)
    .maybeSingle()

  const hs = hsData as HubSpotCompany | null

  return (
    <main className="px-8 py-8 space-y-6 max-w-4xl">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/accounts" className="text-slate-400 hover:text-slate-600 transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <Breadcrumbs items={[
          { label: 'Comptes', href: '/dashboard/accounts' },
          { label: a.stripe_customer_id ?? params.id },
        ]} />
      </div>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 font-mono">{a.stripe_customer_id ?? params.id}</h1>
          {hs?.hubspot_company_id && (
            <p className="text-sm text-slate-500 mt-1 font-mono">HubSpot : {hs.hubspot_company_id}</p>
          )}
        </div>
        <div className="flex gap-2">
          <ScoreBadge score={a.health_score} type="health" />
          <ScoreBadge score={a.churn_risk_score} type="churn" />
          <ScoreBadge score={a.expansion_score} type="expansion" />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Facturation Stripe */}
        <Section title="Facturation Stripe">
          <Row label="Plan" value={<span className="capitalize">{a.plan_tier ?? '—'}</span>} />
          <Row label="Intervalle" value={
            a.billing_interval === 'year' ? 'Annuel' :
            a.billing_interval === 'month' ? 'Mensuel' : '—'
          } />
          <Row label="MRR" value={<span className="font-bold text-slate-900">{formatMrr(a.mrr_cents ?? 0)}</span>} />
          <Row label="Sièges" value={
            a.seat_count !== null
              ? `${a.seat_count}${a.seat_limit ? ` / ${a.seat_limit}` : ''}`
              : '—'
          } />
          <Row label="Début contrat" value={
            a.contract_start_date
              ? new Date(a.contract_start_date).toLocaleDateString('fr-FR')
              : '—'
          } />
          <Row label="Renouvellement" value={
            a.contract_end_date
              ? new Date(a.contract_end_date).toLocaleDateString('fr-FR')
              : '—'
          } />
        </Section>

        {/* Scores */}
        <Section title="Scores de santé">
          <Row label="Score global" value={
            a.health_score !== null
              ? <span className="font-bold">{a.health_score}/100</span>
              : '—'
          } />
          <Row label="Risque churn" value={
            a.churn_risk_score !== null
              ? <span className="font-bold">{a.churn_risk_score}/100</span>
              : '—'
          } />
          <Row label="Opportunité expansion" value={
            a.expansion_score !== null
              ? <span className="font-bold">{a.expansion_score}/100</span>
              : '—'
          } />
          <Row label="Score financier" value={a.financial_score !== null ? `${a.financial_score}/100` : '—'} />
          <Row label="Score engagement" value={a.engagement_score !== null ? `${a.engagement_score}/100` : '—'} />
          <Row label="Score contrat" value={a.contract_score !== null ? `${a.contract_score}/100` : '—'} />
          {a.usage_tracker_connected && (
            <Row label="Score usage produit" value={a.product_usage_score !== null ? `${a.product_usage_score}/100` : '—'} />
          )}
        </Section>

        {/* HubSpot */}
        <Section title="HubSpot CRM">
          {!hs ? (
            <p className="text-sm text-slate-400 italic">
              Aucune donnée HubSpot — connectez HubSpot dans les paramètres ou ajoutez la propriété{' '}
              <span className="font-mono text-slate-500">id_stripe</span> sur la company HubSpot.
            </p>
          ) : (
            <>
              <Row label="ID Company" value={<span className="font-mono text-xs">{hs.hubspot_company_id}</span>} />
              <Row label="Lifecycle stage" value={formatLifecycleStage(hs.lifecycle_stage)} />
              <Row
                label="Dernier RDV"
                value={
                  hs.last_meeting_date ? (
                    <span className="flex flex-col items-end">
                      <span>{new Date(hs.last_meeting_date).toLocaleDateString('fr-FR')}</span>
                      <span className="text-xs text-slate-400">{daysAgo(hs.last_meeting_date)}</span>
                    </span>
                  ) : (
                    <span className="text-slate-400 italic text-xs">Aucun RDV enregistré</span>
                  )
                }
              />
              <Row
                label="Tickets ouverts"
                value={
                  hs.open_ticket_count !== null ? (
                    <span className={hs.open_ticket_count >= 3 ? 'text-red-600 font-bold' : hs.open_ticket_count > 0 ? 'text-amber-600' : 'text-green-600'}>
                      {hs.open_ticket_count}
                    </span>
                  ) : '—'
                }
              />
              <Row label="Deals en cours" value={hs.open_deal_count ?? '—'} />
              <Row label="Dernière sync" value={
                hs.last_synced_at
                  ? new Date(hs.last_synced_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                  : '—'
              } />
            </>
          )}
        </Section>

        {/* Usage produit */}
        <Section title="Usage produit">
          {!a.usage_tracker_connected ? (
            <p className="text-sm text-slate-400 italic">
              Tracker usage non connecté. Les scores d&apos;usage ne sont pas calculés en V1.
            </p>
          ) : (
            <Row label="Score usage" value={a.product_usage_score !== null ? `${a.product_usage_score}/100` : '—'} />
          )}
          <Row label="Créé le" value={new Date(a.created_at).toLocaleDateString('fr-FR')} />
          <Row label="Mis à jour" value={new Date(a.updated_at).toLocaleDateString('fr-FR')} />
        </Section>
      </div>
    </main>
  )
}
