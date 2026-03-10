import Link from 'next/link'
import { ChevronRight } from 'lucide-react'

interface BreadcrumbItem {
  label: string
  href?: string
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[]
}

export function Breadcrumbs({ items }: BreadcrumbsProps) {
  return (
    <nav aria-label="Fil d'Ariane" className="flex items-center gap-1.5 text-sm">
      {items.map((item, i) => {
        const isLast = i === items.length - 1
        return (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
            {isLast || !item.href ? (
              <span className={isLast ? 'font-medium text-slate-900' : 'text-slate-500'}>
                {item.label}
              </span>
            ) : (
              <Link href={item.href} className="text-slate-500 hover:text-slate-700 transition-colors">
                {item.label}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}
