import { createSupabaseServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Settings, Plug, Webhook } from 'lucide-react'

interface Integration {
  provider: string
  provider_account_id: string | null
  integration_method: string | null
  status: string
}

interface WebhookConfig {
  endpoint_url: string | null
  active_events: string[] | null
  is_active: boolean
  last_triggered_at: string | null
  failure_count: number
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

export default async function SettingsPage() {
  const orgId = await getProfileOrgId()
  if (!orgId) redirect('/auth/login')

  const supabase = createSupabaseServerClient()

  // Fetch integrations
  const { data: integrationsData } = await supabase
    .from('organization_integrations')
    .select('provider, provider_account_id, integration_method, status')
    .eq('organization_id', orgId)

  const integrations = (integrationsData ?? []) as Integration[]
  const stripeInt = integrations.find((i) => i.provider === 'stripe')
  const hubspotInt = integrations.find((i) => i.provider === 'hubspot')

  // Fetch webhook config
  const { data: webhookData } = await supabase
    .from('webhook_configs')
    .select('endpoint_url, active_events, is_active, last_triggered_at, failure_count')
    .eq('organization_id', orgId)
    .maybeSingle()

  const webhook = webhookData as WebhookConfig | null

  return (
    <main className="px-8 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Paramètres</h1>
        <p className="text-slate-500 mt-1">Intégrations et configuration</p>
      </div>

      {/* Integrations */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Plug className="w-5 h-5 text-slate-400" />
          <h2 className="text-lg font-semibold text-slate-900">Intégrations</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Stripe */}
          <IntegrationCard
            name="Stripe"
            description="Synchronisation des abonnements, factures et MRR"
            connected={stripeInt?.status === 'active'}
            method={stripeInt?.integration_method}
            accountId={stripeInt?.provider_account_id}
            accentColor="bg-violet-500"
          />

          {/* HubSpot */}
          <IntegrationCard
            name="HubSpot"
            description="Synchronisation des données d'engagement (tickets, meetings)"
            connected={hubspotInt?.status === 'active'}
            method={hubspotInt?.integration_method}
            accountId={hubspotInt?.provider_account_id}
            accentColor="bg-orange-500"
          />
        </div>
      </section>

      {/* Webhook */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Webhook className="w-5 h-5 text-slate-400" />
          <h2 className="text-lg font-semibold text-slate-900">Webhook sortant</h2>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-6">
          {webhook?.endpoint_url ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-700">Endpoint</p>
                  <p className="text-sm text-slate-500 font-mono">{webhook.endpoint_url}</p>
                </div>
                <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                  webhook.is_active
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-red-100 text-red-700'
                }`}>
                  {webhook.is_active ? 'Actif' : 'Désactivé'}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-slate-400 text-xs">Événements actifs</p>
                  <p className="font-medium text-slate-700">
                    {webhook.active_events?.length ?? 0}
                  </p>
                </div>
                <div>
                  <p className="text-slate-400 text-xs">Dernier déclenchement</p>
                  <p className="font-medium text-slate-700">
                    {webhook.last_triggered_at
                      ? new Date(webhook.last_triggered_at).toLocaleDateString('fr-FR')
                      : 'Jamais'}
                  </p>
                </div>
                <div>
                  <p className="text-slate-400 text-xs">Échecs consécutifs</p>
                  <p className={`font-medium ${webhook.failure_count > 0 ? 'text-red-600' : 'text-slate-700'}`}>
                    {webhook.failure_count}
                  </p>
                </div>
              </div>

              {webhook.active_events && webhook.active_events.length > 0 && (
                <div>
                  <p className="text-xs text-slate-400 mb-2">Événements</p>
                  <div className="flex flex-wrap gap-1.5">
                    {webhook.active_events.map((evt) => (
                      <span key={evt} className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-xs">
                        {evt}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-6">
              <Webhook className="w-8 h-8 text-slate-300 mx-auto mb-3" />
              <p className="text-sm font-medium text-slate-700 mb-1">Webhook non configuré</p>
              <p className="text-xs text-slate-400 max-w-sm mx-auto">
                Configurez un webhook sortant pour envoyer des événements Sentio vers vos outils (Brevo, Salesforce, backend custom).
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Scoring info */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-slate-400" />
          <h2 className="text-lg font-semibold text-slate-900">Scoring</h2>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
            <div>
              <p className="font-medium text-slate-700 mb-2">Formule Health Score (V1)</p>
              <div className="space-y-1 text-slate-500">
                <p>Financial <span className="font-mono text-slate-700">34%</span></p>
                <p>Engagement <span className="font-mono text-slate-700">33%</span></p>
                <p>Contract <span className="font-mono text-slate-700">33%</span></p>
              </div>
              <p className="text-xs text-slate-400 mt-2">Usage tracker non connecté — dimension suspendue</p>
            </div>
            <div>
              <p className="font-medium text-slate-700 mb-2">Formule Health Score (futur)</p>
              <div className="space-y-1 text-slate-500">
                <p>Usage <span className="font-mono text-slate-700">35%</span></p>
                <p>Financial <span className="font-mono text-slate-700">25%</span></p>
                <p>Engagement <span className="font-mono text-slate-700">20%</span></p>
                <p>Contract <span className="font-mono text-slate-700">20%</span></p>
              </div>
              <p className="text-xs text-slate-400 mt-2">Actif quand le usage tracker sera connecté</p>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}

function IntegrationCard({
  name,
  description,
  connected,
  method,
  accountId,
  accentColor,
}: {
  name: string
  description: string
  connected: boolean
  method?: string | null
  accountId?: string | null
  accentColor: string
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-lg ${accentColor} flex items-center justify-center`}>
          <span className="text-white font-bold text-sm">{name[0]}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-slate-900 text-sm">{name}</p>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
              connected
                ? 'bg-emerald-100 text-emerald-700'
                : 'bg-slate-100 text-slate-500'
            }`}>
              {connected ? 'Connecté' : 'Non connecté'}
            </span>
          </div>
          <p className="text-xs text-slate-400">{description}</p>
        </div>
      </div>

      {connected && (
        <div className="flex items-center gap-4 text-xs text-slate-500 pl-[52px]">
          {method && (
            <span>Méthode : <span className="font-medium text-slate-700">{method === 'api_key' ? 'Clé API' : 'OAuth'}</span></span>
          )}
          {accountId && (
            <span className="font-mono text-slate-400 truncate">{accountId}</span>
          )}
        </div>
      )}
    </div>
  )
}
