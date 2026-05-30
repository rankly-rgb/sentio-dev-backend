import { createSupabaseServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { SyncButtons } from './SyncButtons'

interface DataSync {
  id: string
  sync_source: string
  sync_type: string
  sync_status: string
  started_at: string | null
  completed_at: string | null
  error_message: string | null
  records_processed: number
  records_created: number
  records_updated: number
  records_failed: number
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

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return '-'
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime()
  if (ms < 1000) return `${ms}ms`
  return `${Math.round(ms / 1000)}s`
}

function formatDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: 'bg-emerald-100 text-emerald-700',
    failed: 'bg-red-100 text-red-700',
    running: 'bg-blue-100 text-blue-700',
    pending: 'bg-amber-100 text-amber-700',
  }
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${styles[status] ?? 'bg-slate-100 text-slate-600'}`}>
      {status}
    </span>
  )
}

function SourceLabel({ source }: { source: string }) {
  const labels: Record<string, string> = {
    stripe: 'Stripe',
    hubspot: 'HubSpot',
    scoring: 'Scoring',
    insights: 'Insights',
  }
  return <span className="font-medium text-slate-900">{labels[source] ?? source}</span>
}

export default async function SyncsPage() {
  const orgId = await getProfileOrgId()
  if (!orgId) redirect('/auth/login')

  const supabase = createSupabaseServerClient()

  const { data: syncsData } = await supabase
    .from('data_syncs')
    .select('id, sync_source, sync_type, sync_status, started_at, completed_at, error_message, records_processed, records_created, records_updated, records_failed')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(50)

  const syncs = (syncsData ?? []) as DataSync[]

  // Vérifier la connexion HubSpot : organization_integrations (nouveau flow Vault)
  // ou organizations.hubspot_connected (flow legacy hubspot-connect)
  const [{ data: hubspotIntegration }, { data: org }] = await Promise.all([
    supabase
      .from('organization_integrations')
      .select('status')
      .eq('organization_id', orgId)
      .eq('provider', 'hubspot')
      .eq('status', 'active')
      .maybeSingle(),
    supabase
      .from('organizations')
      .select('hubspot_connected')
      .eq('id', orgId)
      .maybeSingle(),
  ])

  const hubspotConnected = !!hubspotIntegration || !!org?.hubspot_connected

  return (
    <main className="px-8 py-8 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Synchronisations</h1>
          <p className="text-slate-500 mt-1">Historique et actions de synchronisation</p>
        </div>
        <SyncButtons hubspotConnected={hubspotConnected} />
      </div>

      <section>
        <h2 className="text-sm font-medium text-slate-500 mb-4">Historique des synchronisations</h2>

        {syncs.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
            <p className="text-sm text-slate-500">Aucune synchronisation pour le moment.</p>
            <p className="text-xs text-slate-400 mt-1">Connectez Stripe ou HubSpot dans Paramètres pour commencer.</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left">
                    <th className="px-4 py-3 text-xs font-medium text-slate-400">Source</th>
                    <th className="px-4 py-3 text-xs font-medium text-slate-400">Type</th>
                    <th className="px-4 py-3 text-xs font-medium text-slate-400">Statut</th>
                    <th className="px-4 py-3 text-xs font-medium text-slate-400">Démarré</th>
                    <th className="px-4 py-3 text-xs font-medium text-slate-400">Durée</th>
                    <th className="px-4 py-3 text-xs font-medium text-slate-400 text-right">Traités</th>
                    <th className="px-4 py-3 text-xs font-medium text-slate-400 text-right">Créés</th>
                    <th className="px-4 py-3 text-xs font-medium text-slate-400 text-right">Mis à jour</th>
                    <th className="px-4 py-3 text-xs font-medium text-slate-400 text-right">Échecs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {syncs.map((sync) => (
                    <tr key={sync.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <SourceLabel source={sync.sync_source} />
                      </td>
                      <td className="px-4 py-3 text-slate-600">{sync.sync_type}</td>
                      <td className="px-4 py-3">
                        <div className="space-y-1">
                          <StatusBadge status={sync.sync_status} />
                          {sync.sync_status === 'failed' && sync.error_message && (
                            <p className="text-xs text-red-500 max-w-xs truncate" title={sync.error_message}>
                              {sync.error_message}
                            </p>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-600 whitespace-nowrap">
                        {formatDate(sync.started_at)}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {formatDuration(sync.started_at, sync.completed_at)}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-700">{sync.records_processed}</td>
                      <td className="px-4 py-3 text-right text-emerald-600">{sync.records_created}</td>
                      <td className="px-4 py-3 text-right text-blue-600">{sync.records_updated}</td>
                      <td className="px-4 py-3 text-right text-red-600">{sync.records_failed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </main>
  )
}
