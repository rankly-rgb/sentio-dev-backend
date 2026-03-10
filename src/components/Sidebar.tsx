'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  CalendarCheck,
  LayoutDashboard,
  Users,
  PieChart,
  BookOpen,
  Lightbulb,
  Settings,
  LogOut,
} from 'lucide-react'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

const NAV_ITEMS = [
  { href: '/dashboard/today', label: 'Aujourd\'hui', icon: CalendarCheck, badge: true },
  { href: '/dashboard', label: 'Vue d\'ensemble', icon: LayoutDashboard },
  { href: '/dashboard/accounts', label: 'Comptes clients', icon: Users },
  { href: '/dashboard/segments', label: 'Segments', icon: PieChart },
  { href: '/dashboard/playbooks', label: 'Playbooks', icon: BookOpen },
  { href: '/dashboard/insights', label: 'Insights IA', icon: Lightbulb },
  { href: '/dashboard/settings', label: 'Paramètres', icon: Settings },
]

interface SidebarProps {
  userName?: string | null
  userRole?: string | null
  todayActionCount?: number | null
}

export function Sidebar({ userName, userRole, todayActionCount }: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()

  function isActive(href: string) {
    if (href === '/dashboard') return pathname === '/dashboard'
    return pathname.startsWith(href)
  }

  async function handleLogout() {
    const supabase = createSupabaseBrowserClient()
    await supabase.auth.signOut()
    router.push('/auth/login')
  }

  return (
    <aside className="fixed inset-y-0 left-0 z-30 w-64 bg-white border-r border-slate-200 flex flex-col">
      {/* Logo */}
      <div className="px-6 py-5 border-b border-slate-100">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
            <span className="text-white font-bold text-sm">S</span>
          </div>
          <div>
            <p className="font-bold text-slate-900 text-sm leading-tight">Sentio AI</p>
            <p className="text-[10px] text-slate-400 uppercase tracking-wider">Customer Intelligence</p>
          </div>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.href)
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              <Icon className="w-5 h-5 flex-shrink-0" />
              <span className="flex-1">{item.label}</span>
              {'badge' in item && item.badge && todayActionCount != null && todayActionCount > 0 && (
                <span className="ml-auto bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[20px] h-5 flex items-center justify-center px-1.5">
                  {todayActionCount > 99 ? '99+' : todayActionCount}
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      {/* User section */}
      <div className="border-t border-slate-200 px-4 py-4">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-900 truncate">
              {userName ?? 'Utilisateur'}
            </p>
            <p className="text-xs text-slate-400 capitalize">{userRole ?? 'member'}</p>
          </div>
          <button
            onClick={handleLogout}
            title="Se déconnecter"
            className="p-2 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  )
}
