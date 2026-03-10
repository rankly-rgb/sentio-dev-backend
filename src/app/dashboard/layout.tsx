import { createSupabaseServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Sidebar } from '@/components/Sidebar'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = createSupabaseServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: profile } = await supabase
    .from('profiles_')
    .select('organization_id, role, full_name')
    .eq('auth_user_id', user.id)
    .maybeSingle()

  return (
    <div className="min-h-screen bg-slate-50">
      <Sidebar userName={profile?.full_name} userRole={profile?.role} />
      <div className="pl-64">
        {children}
      </div>
    </div>
  )
}
