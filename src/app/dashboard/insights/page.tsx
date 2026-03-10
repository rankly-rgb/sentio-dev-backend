import { createSupabaseServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { EmptyState } from '@/components/EmptyState'
import { formatMrr } from '@/lib/segment-queries'
import { Lightbulb, AlertTriangle, TrendingUp, CreditCard, Activity, ArrowDown } from 'lucide-react'

interface Insight {
  id: string
  type: string
  title: string
  description: string | null
  priority: string
  status: string
  confidence_score: number | null
  impact_mrr_cents: number | null
  recommended_action: string | null
  created_at: string
}

const TYPE_CONFIG: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; color: string; bg: string }> = {
  churn_prediction: { label: 'Prédiction churn', icon: AlertTriangle, color: 'text-red-600', bg: 'bg-red-50' },
  expansion_opportunity: { label: 'Opportunité expansion', icon: TrendingUp, color: 'text-blue-600', bg: 'bg-blue-50' },
  renewal_alert: { label: 'Alerte renouvellement', icon: Activity, color: 'text-amber-600', bg: 'bg-amber-50' },
  payment_risk: { label: 'Risque paiement', icon: CreditCard, color: 'text-rose-600', bg: 'bg-rose-50' },
  usage_drop: { label: 'Chute usage', icon: ArrowDown, color: 'text-orange-600', bg: 'bg-orange-50' },
}

const PRIORITY_CONFIG: Record<string, { label: string; color: string }> = {
  critical: { label: 'Critique', color: 'text-red-600 bg-red-100' },
  high: { label: 'Haute', color: 'text-orange-600 bg-orange-100' },
  medium: { label: 'Moyenne', color: 'text-amber-600 bg-amber-100' },
  low: { label: 'Basse', color: 'text-slate-500 bg-slate-100' },
}

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  active: { label: 'Actif', color: 'text-emerald-700 bg-emerald-100' },
  acknowledged: { label: 'Pris en compte', color: 'text-blue-700 bg-blue-100' },
  resolved: { label: 'Résolu', color: 'text-slate-500 bg-slate-100' },
  dismissed: { label: 'Ignoré', color: 'text-gray-400 bg-gray-100' },
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

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const hours = Math.floor(diff / 3600000)
  if (hours < 1) return 'Il y a moins d\'1h'
  if (hours < 24) return `Il y a ${hours}h`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'Hier'
  return `Il y a ${days}j`
}

export default async function InsightsPage() {
  const orgId = await getProfileOrgId()
  if (!orgId) redirect('/auth/login')

  const supabase = createSupabaseServerClient()
  const { data } = await supabase
    .from('ai_insights')
    .select('id, type, title, description, priority, status, confidence_score, impact_mrr_cents, recommended_action, created_at')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(100)

  const insights = (data ?? []) as Insight[]

  const activeCount = insights.filter((i) => i.status === 'active').length
  const totalImpact = insights
    .filter((i) => i.status === 'active')
    .reduce((sum, i) => sum + (i.impact_mrr_cents ?? 0), 0)

  return (
    <main className="px-8 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Insights IA</h1>
        <p className="text-slate-500 mt-1">
          {activeCount > 0
            ? `${activeCount} insights actifs — ${formatMrr(totalImpact)} de MRR impacté`
            : 'Détections automatiques basées sur vos données'}
        </p>
      </div>

      {insights.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200">
          <EmptyState
            icon={Lightbulb}
            title="Aucun insight généré"
            description="Les insights seront générés automatiquement après la synchronisation de vos données et le calcul des scores."
          />
        </div>
      ) : (
        <div className="space-y-3">
          {insights.map((insight) => {
            const typeConf = TYPE_CONFIG[insight.type] ?? TYPE_CONFIG.churn_prediction
            const priorityConf = PRIORITY_CONFIG[insight.priority] ?? PRIORITY_CONFIG.medium
            const statusConf = STATUS_CONFIG[insight.status] ?? STATUS_CONFIG.active
            const Icon = typeConf.icon

            return (
              <div
                key={insight.id}
                className="bg-white rounded-xl border border-slate-200 p-5 hover:shadow-sm transition-shadow"
              >
                <div className="flex items-start gap-4">
                  {/* Icon */}
                  <div className={`w-10 h-10 rounded-lg ${typeConf.bg} flex items-center justify-center shrink-0`}>
                    <Icon className={`w-5 h-5 ${typeConf.color}`} />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h3 className="font-semibold text-slate-900 text-sm">{insight.title}</h3>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${priorityConf.color}`}>
                        {priorityConf.label}
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusConf.color}`}>
                        {statusConf.label}
                      </span>
                    </div>

                    {insight.description && (
                      <p className="text-sm text-slate-500 mb-2 line-clamp-2">{insight.description}</p>
                    )}

                    {insight.recommended_action && (
                      <p className="text-xs text-indigo-600 font-medium mb-2">
                        Action recommandée : {insight.recommended_action}
                      </p>
                    )}

                    <div className="flex items-center gap-4 text-xs text-slate-400">
                      <span className={`font-medium ${typeConf.color}`}>{typeConf.label}</span>
                      {insight.confidence_score !== null && (
                        <span>Confiance : {Math.round(insight.confidence_score)}%</span>
                      )}
                      {insight.impact_mrr_cents !== null && insight.impact_mrr_cents > 0 && (
                        <span className="font-medium text-slate-600">
                          Impact : {formatMrr(insight.impact_mrr_cents)}
                        </span>
                      )}
                      <span>{timeAgo(insight.created_at)}</span>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
