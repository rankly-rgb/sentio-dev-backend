'use client'

import { useState } from 'react'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'

interface ExportCsvButtonOptions {
  segmentId?: string
  minChurnRisk?: number
  label?: string
}

export function ExportCsvButton({ segmentId, minChurnRisk, label = '↓ Export CSV' }: ExportCsvButtonOptions) {
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleExport() {
    setExporting(true)
    setError(null)

    try {
      const supabase = createSupabaseBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()

      const body: Record<string, unknown> = {
        include_email: true,
        limit: 2000,
      }
      if (segmentId) body.segment_id = segmentId
      if (minChurnRisk !== undefined) body.filters = { min_churn_risk: minChurnRisk }

      const resp = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/export-csv`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session?.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      )

      if (!resp.ok) throw new Error(`Export failed: ${resp.status}`)

      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `sentio-export-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur inconnue'
      setError(msg)
      setTimeout(() => setError(null), 5000)
    } finally {
      setExporting(false)
    }
  }

  async function handleSequenceTemplate() {
    try {
      const supabase = createSupabaseBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()

      const url = new URL(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/export-csv`)
      url.searchParams.set('format', 'sequence_template')
      if (segmentId) url.searchParams.set('segment_id', segmentId)

      const resp = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${session?.access_token}` },
      })

      if (!resp.ok) throw new Error(`Download failed: ${resp.status}`)

      const blob = await resp.blob()
      const dlUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = dlUrl
      a.download = `sentio-sequence-${new Date().toISOString().slice(0, 10)}.txt`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(dlUrl)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur inconnue'
      setError(msg)
      setTimeout(() => setError(null), 5000)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          onClick={handleExport}
          disabled={exporting}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {exporting ? (
            <>
              <span className="inline-block w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Export en cours...
            </>
          ) : (
            label
          )}
        </button>

        <button
          onClick={handleSequenceTemplate}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-slate-600 text-sm hover:bg-slate-50 transition-colors"
        >
          Modele sequence
        </button>
      </div>

      <p className="text-xs text-slate-400">
        Les emails sont recuperes depuis Stripe au moment de l&apos;export — jamais stockes par Sentio.
      </p>

      {error && (
        <p className="text-xs text-red-500 mt-0.5">{error}</p>
      )}
    </div>
  )
}
