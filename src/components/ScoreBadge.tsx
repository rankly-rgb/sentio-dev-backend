/**
 * Color-coded score badge with semantic label.
 * Used across accounts tables, segment details, dashboard widgets.
 */

interface ScoreBadgeProps {
  score: number | null
  type?: 'health' | 'churn' | 'expansion'
  showLabel?: boolean
  size?: 'sm' | 'md'
}

function getHealthConfig(score: number) {
  if (score >= 70) return { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Sain' }
  if (score >= 40) return { bg: 'bg-amber-100', text: 'text-amber-700', label: 'Attention' }
  return { bg: 'bg-red-100', text: 'text-red-700', label: 'Critique' }
}

function getChurnConfig(score: number) {
  if (score >= 70) return { bg: 'bg-red-100', text: 'text-red-700', label: 'Élevé' }
  if (score >= 40) return { bg: 'bg-amber-100', text: 'text-amber-700', label: 'Modéré' }
  return { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Faible' }
}

function getExpansionConfig(score: number) {
  if (score >= 70) return { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Fort' }
  if (score >= 40) return { bg: 'bg-slate-100', text: 'text-slate-600', label: 'Modéré' }
  return { bg: 'bg-slate-50', text: 'text-slate-400', label: 'Faible' }
}

export function ScoreBadge({ score, type = 'health', showLabel = false, size = 'sm' }: ScoreBadgeProps) {
  if (score === null || score === undefined) {
    return (
      <span className={`inline-flex items-center ${size === 'sm' ? 'text-xs' : 'text-sm'} text-slate-400`}>
        —
      </span>
    )
  }

  const rounded = Math.round(score)
  const config =
    type === 'churn'
      ? getChurnConfig(rounded)
      : type === 'expansion'
      ? getExpansionConfig(rounded)
      : getHealthConfig(rounded)

  const sizeClass = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm'

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ${config.bg} ${config.text} ${sizeClass}`}
    >
      {rounded}
      {showLabel && <span className="font-normal">{config.label}</span>}
    </span>
  )
}
