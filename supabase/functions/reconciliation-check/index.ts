// ============================================================
// Edge Function : reconciliation-check
// Job de réconciliation quotidien : vérifie que le cache dénormalisé
// account_segments.account_count reste cohérent avec le comptage live
// de segment_memberships (status='active'). Alerte Slack en cas d'écart.
//
// Ce cache est mis à jour par calculate-scores à chaque run de scoring
// (calculate-scores/index.ts) ; segment_memberships peut aussi être
// modifié par d'autres chemins sans que ce cache soit resynchronisé —
// c'est exactement la dérive que ce job détecte.
//
// Devrait être appelé quotidiennement via cron, après calculate-scores.
// ============================================================
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, jsonResponse, errorResponse } from '../_shared/supabase-client.ts'
import { acquireCronLock, releaseCronLock } from '../_shared/cron-lock.ts'
import { alertSlack } from '../_shared/slack-alert.ts'
import { findDrift, type SegmentCount, type DriftEntry } from '../_shared/reconciliation.ts'

interface OrgDriftResult {
  organization_id: string
  drifts: DriftEntry[]
}

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'reconciliation-check', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const lockAcquired = await acquireCronLock(supabase, 'reconciliation-check', 300)
  if (!lockAcquired) {
    return jsonResponse({ success: true, skipped: true, reason: 'already_running' })
  }

  const orgResults: OrgDriftResult[] = []
  let orgsChecked = 0

  try {
    const { data: orgs, error: orgError } = await supabase
      .from('organizations')
      .select('id')
      .eq('is_active', true)

    if (orgError) {
      console.error(JSON.stringify({ level: 'error', function_name: 'reconciliation-check', message: orgError.message }))
      return errorResponse('Failed to fetch organizations', 500)
    }

    for (const org of orgs ?? []) {
      orgsChecked++

      try {
        const { data: segments, error: segError } = await supabase
          .from('account_segments')
          .select('id, segment_type, account_count')
          .eq('organization_id', org.id)
          .eq('is_active', true)

        if (segError) {
          console.error(JSON.stringify({
            level: 'error',
            function_name: 'reconciliation-check',
            organization_id: org.id,
            message: segError.message,
          }))
          continue
        }

        const segmentCounts: SegmentCount[] = []
        for (const seg of segments ?? []) {
          const { count, error: countError } = await supabase
            .from('segment_memberships')
            .select('id', { count: 'exact', head: true })
            .eq('segment_id', seg.id)
            .eq('status', 'active')

          if (countError) {
            console.error(JSON.stringify({
              level: 'error',
              function_name: 'reconciliation-check',
              organization_id: org.id,
              segment_id: seg.id,
              message: countError.message,
            }))
            continue
          }

          segmentCounts.push({
            segment_type: seg.segment_type,
            cached: seg.account_count ?? 0,
            live: count ?? 0,
          })
        }

        const drifts = findDrift(segmentCounts)
        if (drifts.length > 0) {
          orgResults.push({ organization_id: org.id, drifts })
        }
      } catch (err) {
        console.error(JSON.stringify({
          level: 'error',
          function_name: 'reconciliation-check',
          organization_id: org.id,
          message: 'Unexpected error checking org',
          error: err instanceof Error ? err.message : String(err),
        }))
      }
    }

    if (orgResults.length > 0) {
      const totalDrifts = orgResults.reduce((sum, r) => sum + r.drifts.length, 0)
      const hasCritical = orgResults.some((r) => r.drifts.some((d) => d.severity === 'critical'))

      const summary = orgResults
        .map((r) => `org ${r.organization_id}: ` + r.drifts.map((d) => `${d.segment_type} cached=${d.cached} live=${d.live}`).join(', '))
        .join(' | ')

      await alertSlack(
        `reconciliation-check: ${totalDrifts} écart(s) détecté(s) sur ${orgResults.length} org(s) — ${summary}`,
        { level: hasCritical ? 'critical' : 'warning' },
      )
    }
  } finally {
    try {
      await releaseCronLock(supabase, 'reconciliation-check')
    } catch (lockErr) {
      console.error(JSON.stringify({
        level: 'error',
        function_name: 'reconciliation-check',
        message: `Failed to release cron lock: ${lockErr instanceof Error ? lockErr.message : String(lockErr)}`,
      }))
    }
  }

  return jsonResponse({
    success: true,
    orgs_checked: orgsChecked,
    drifts_found: orgResults.reduce((sum, r) => sum + r.drifts.length, 0),
    details: orgResults,
    timestamp: new Date().toISOString(),
  })
})
