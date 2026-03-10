import { type LucideIcon, Inbox } from 'lucide-react'
import Link from 'next/link'

interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description: string
  actionLabel?: string
  actionHref?: string
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  actionLabel,
  actionHref,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-4">
        <Icon className="w-6 h-6 text-slate-400" />
      </div>
      <h3 className="text-sm font-semibold text-slate-900 mb-1">{title}</h3>
      <p className="text-sm text-slate-500 max-w-sm">{description}</p>
      {actionLabel && actionHref && (
        <Link
          href={actionHref}
          className="mt-4 px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
        >
          {actionLabel}
        </Link>
      )}
    </div>
  )
}
