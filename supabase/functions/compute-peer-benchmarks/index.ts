// ============================================================
// Edge Function : compute-peer-benchmarks
// Calcule quotidiennement les percentiles de NRR, churn rate et
// croissance MRR à partir de toutes les organisations actives,
// et persiste le snapshot dans peer_benchmarks.
//
// Déclenché en cron (service_role). Requiert >= 3 orgs avec
// des données MRR pour produire un snapshot (Zero-PII).
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
// POST /compute-peer-benchmarks
//   Headers : Authorization: Bearer <service_role_key>
//   Response 200 :
//     { success: true, org_count: number, snapshot_id: string | null }
//   Response 200 (not enough data) :
//     { success: true, org_count: number, snapshot_id: null, reason: string }
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { acquireCronLock, releaseCronLock } from '../_shared/cron-lock.ts'
import { alertSlack } from '../_shared/slack-alert.ts'
import { withSentry } from '../_shared/sentry.ts'

const LOCK_KEY = 'compute-peer-benchmarks'
const MIN_ORGS = 3
const RETENTION_DAYS = 30

// ── Types ────────────────────────────────────────────────────

export type OrgMetrics = {
  nrr: number
  churnRate: number
  mrrGrowth: number
}

export type PeerSnapshot = {
  org_count: number
  nrr_p25: number; nrr_p50: number; nrr_p75: number
  churn_rate_p25: number; churn_rate_p50: number; churn_rate_p75: number
  mrr_growth_p25: number; mrr_growth_p50: number; mrr_growth_p75: number
}

// ── Fonctions pures (exportées pour les tests) ───────────────

export function calcOrgMetrics(
  currentMrr: number,
  movements: Array<{ movement_type: string; amount_cents: number | null }>,
): OrgMetrics | null {
  let new12m = 0, expansion12m = 0, contraction12m = 0, churn12m = 0, reactivation12m = 0
  for (const m of movements) {
    const amt = m.amount_cents ?? 0
    switch (m.movement_type) {
      case 'new': new12m += amt; break
      case 'expansion': expansion12m += amt; break
      case 'contraction': contraction12m += amt; break
      case 'churn': churn12m += amt; break
      case 'reactivation': reactivation12m += amt; break
    }
  }

  // contraction/churn sont stockés NÉGATIFS dans mrr_movements (classifyMovement,
  // _shared/mrr-engine.ts) — donc on les ADDITIONNE pour obtenir le net, jamais
  // les soustraire une seconde fois (ça inverserait leur effet). Convention
  // identique à calcNrrPercentage/calcChurnRate30d (_shared/mrr-engine.ts).
  // Issue #28 : l'ancienne formule "- contraction12m - churn12m" gonflait le
  // netMovements/NRR/mrrGrowth et produisait un churnRate négatif.
  const netMovements = new12m + expansion12m + reactivation12m + contraction12m + churn12m
  const startingMrr = currentMrr - netMovements
  if (startingMrr <= 0) return null

  const endingMrrExisting = currentMrr - new12m
  const nrr = Math.round((endingMrrExisting / startingMrr) * 1000) / 10
  const churnRate = Math.round((Math.abs(churn12m) / startingMrr) * 1000) / 10
  const mrrGrowth = Math.round((netMovements / startingMrr) * 1000) / 10

  return { nrr, churnRate, mrrGrowth }
}

export function computePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (p / 100) * (sorted.length - 1)
  const lower = Math.floor(idx)
  const upper = Math.ceil(idx)
  if (lower === upper) return Math.round(sorted[lower] * 100) / 100
  const interpolated = sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower)
  return Math.round(interpolated * 100) / 100
}

export function buildPeerSnapshot(metrics: OrgMetrics[]): PeerSnapshot {
  const nrrs = metrics.map(m => m.nrr).sort((a, b) => a - b)
  const churns = metrics.map(m => m.churnRate).sort((a, b) => a - b)
  const growths = metrics.map(m => m.mrrGrowth).sort((a, b) => a - b)

  return {
    org_count: metrics.length,
    nrr_p25: computePercentile(nrrs, 25),
    nrr_p50: computePercentile(nrrs, 50),
    nrr_p75: computePercentile(nrrs, 75),
    churn_rate_p25: computePercentile(churns, 25),
    churn_rate_p50: computePercentile(churns, 50),
    churn_rate_p75: computePercentile(churns, 75),
    mrr_growth_p25: computePercentile(growths, 25),
    mrr_growth_p50: computePercentile(growths, 50),
    mrr_growth_p75: computePercentile(growths, 75),
  }
}

// ── Entrypoint ───────────────────────────────────────────────

Deno.serve(withSentry('compute-peer-benchmarks', async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: LOCK_KEY, message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const acquired = await acquireCronLock(supabase, LOCK_KEY, 300)
  if (!acquired) {
    return jsonResponse({ success: false, reason: 'Lock already held' }, 409)
  }

  try {
    const twelveMonthsAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]

    // Récupérer toutes les orgs actives (ayant au moins un account avec mrr > 0)
    const { data: orgsData, error: orgsError } = await supabase
      .from('accounts')
      .select('organization_id, mrr_cents')
      .gt('mrr_cents', 0)
      .limit(10000)

    if (orgsError) throw new Error(`accounts query: ${orgsError.message}`)

    // Agréger le MRR actuel par org
    const mrrByOrg = new Map<string, number>()
    for (const row of (orgsData ?? [])) {
      const prev = mrrByOrg.get(row.organization_id) ?? 0
      mrrByOrg.set(row.organization_id, prev + (row.mrr_cents ?? 0))
    }

    if (mrrByOrg.size === 0) {
      return jsonResponse({ success: true, org_count: 0, snapshot_id: null, reason: 'No orgs with MRR data' })
    }

    // Récupérer les mouvements MRR 12 mois pour toutes les orgs en une seule query
    const { data: movementsData, error: movementsError } = await supabase
      .from('mrr_movements')
      .select('organization_id, movement_type, amount_cents')
      .gte('movement_date', twelveMonthsAgo)
      .limit(100000)

    if (movementsError) throw new Error(`mrr_movements query: ${movementsError.message}`)

    // Grouper les mouvements par org
    const movementsByOrg = new Map<string, Array<{ movement_type: string; amount_cents: number | null }>>()
    for (const m of (movementsData ?? [])) {
      const list = movementsByOrg.get(m.organization_id) ?? []
      list.push({ movement_type: m.movement_type, amount_cents: m.amount_cents })
      movementsByOrg.set(m.organization_id, list)
    }

    // Calculer les métriques par org
    const allMetrics: OrgMetrics[] = []
    for (const [orgId, currentMrr] of mrrByOrg) {
      const movements = movementsByOrg.get(orgId) ?? []
      const metrics = calcOrgMetrics(currentMrr, movements)
      if (metrics !== null) allMetrics.push(metrics)
    }

    if (allMetrics.length < MIN_ORGS) {
      return jsonResponse({
        success: true,
        org_count: allMetrics.length,
        snapshot_id: null,
        reason: `Not enough orgs with data (${allMetrics.length}/${MIN_ORGS} required)`,
      })
    }

    // Construire et persister le snapshot
    const snapshot = buildPeerSnapshot(allMetrics)

    const { data: inserted, error: insertError } = await supabase
      .from('peer_benchmarks')
      .insert({ computed_at: new Date().toISOString(), ...snapshot })
      .select('id')
      .single()

    if (insertError) throw new Error(`peer_benchmarks insert: ${insertError.message}`)

    // Nettoyer les snapshots > 30 jours
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
    await supabase.from('peer_benchmarks').delete().lt('computed_at', cutoff)

    console.log(JSON.stringify({
      level: 'info',
      function_name: LOCK_KEY,
      message: 'Peer benchmarks computed',
      org_count: snapshot.org_count,
      snapshot_id: inserted?.id,
    }))

    return jsonResponse({ success: true, org_count: snapshot.org_count, snapshot_id: inserted?.id ?? null })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: LOCK_KEY, message: msg }))
    await alertSlack(`[compute-peer-benchmarks] Erreur : ${msg}`)
    return errorResponse('Internal error', 500)
  } finally {
    await releaseCronLock(supabase, LOCK_KEY)
  }
}))
