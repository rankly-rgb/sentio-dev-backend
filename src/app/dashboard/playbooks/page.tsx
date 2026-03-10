import { createSupabaseServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { EmptyState } from '@/components/EmptyState'
import { BookOpen, Zap } from 'lucide-react'

interface Playbook {
  id: string
  title: string
  description: string | null
  status: string
  priority: string | null
  playbook_type: string | null
  is_template: boolean
  accounts_targeted: number
  accounts_reached: number
  current_eligible_count?: number
  created_at: string
  updated_at: string
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

async function getPlaybooks(orgId: string): Promise<Playbook[]> {
  const supabase = createSupabaseServerClient()
  const { data } = await supabase
    .from('playbooks')
    .select('id, title, description, status, priority, playbook_type, is_template, accounts_targeted, accounts_reached, created_at, updated_at')
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(100)

  return (data ?? []) as Playbook[]
}

export default async function PlaybooksPage() {
  const orgId = await getProfileOrgId()
  if (!orgId) redirect('/auth/login')

  const playbooks = await getPlaybooks(orgId)

  const statusConfig: Record<string, { label: string; bg: string; text: string }> = {
    draft: { label: 'Brouillon', bg: 'bg-slate-100', text: 'text-slate-600' },
    active: { label: 'Actif', bg: 'bg-emerald-100', text: 'text-emerald-700' },
    paused: { label: 'En pause', bg: 'bg-amber-100', text: 'text-amber-700' },
    completed: { label: 'Terminé', bg: 'bg-blue-100', text: 'text-blue-700' },
    archived: { label: 'Archivé', bg: 'bg-gray-100', text: 'text-gray-500' },
  }

  const priorityConfig: Record<string, { label: string; color: string }> = {
    critical: { label: 'Critique', color: 'text-red-600' },
    high: { label: 'Haute', color: 'text-orange-600' },
    medium: { label: 'Moyenne', color: 'text-amber-600' },
    low: { label: 'Basse', color: 'text-slate-500' },
  }

  return (
    <main className="px-8 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Playbooks</h1>
        <p className="text-slate-500 mt-1">{playbooks.length} playbooks configurés</p>
      </div>

      {playbooks.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200">
          <EmptyState
            icon={BookOpen}
            title="Aucun playbook"
            description="Les playbooks automatisent vos actions de rétention. Ils seront créés automatiquement après la première synchronisation."
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {playbooks.map((pb) => {
            const status = statusConfig[pb.status] ?? statusConfig.draft
            const priority = pb.priority ? priorityConfig[pb.priority] : null

            return (
              <div
                key={pb.id}
                className="bg-white rounded-xl border border-slate-200 p-5 hover:shadow-md transition-shadow space-y-3"
              >
                {/* Header */}
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold text-slate-900 text-sm leading-snug">{pb.title}</h3>
                  <span className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${status.bg} ${status.text}`}>
                    {status.label}
                  </span>
                </div>

                {/* Description */}
                {pb.description && (
                  <p className="text-xs text-slate-500 line-clamp-2">{pb.description}</p>
                )}

                {/* Meta */}
                <div className="flex items-center gap-3 text-xs">
                  {priority && (
                    <span className={`font-medium ${priority.color}`}>
                      {priority.label}
                    </span>
                  )}
                  {pb.is_template && (
                    <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 font-medium">
                      Template
                    </span>
                  )}
                  {pb.playbook_type && (
                    <span className="text-slate-400 capitalize">{pb.playbook_type}</span>
                  )}
                </div>

                {/* Stats */}
                <div className="flex items-center gap-4 pt-2 border-t border-slate-100 text-xs">
                  <div className="flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-indigo-500" />
                    <span className="font-semibold text-slate-700">
                      {pb.current_eligible_count ?? '—'}
                    </span>
                    <span className="text-slate-400">éligibles</span>
                  </div>
                  <div>
                    <span className="font-medium text-slate-600">{pb.accounts_targeted}</span>
                    <span className="text-slate-400 ml-1">ciblés</span>
                  </div>
                  <div>
                    <span className="font-medium text-slate-600">{pb.accounts_reached}</span>
                    <span className="text-slate-400 ml-1">touchés</span>
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
