/**
 * Edge Function : get-benchmark-data
 *
 * Retourne les métriques NRR, Churn Rate et MRR Growth de l'organisation
 * courante, comparées aux benchmarks externes SaaS B2B et à la médiane
 * des organisations actives dans Sentio (peer comparison).
 *
 * ────────────────────────────────────────────────────────
 * Contrat API
 * ────────────────────────────────────────────────────────
 * Méthode : GET
 * Auth    : JWT Supabase obligatoire (Bearer token)
 * Route   : /functions/v1/get-benchmark-data
 *
 * Réponse 200 :
 * {
 *   computed_at: string,        // ISO timestamp
 *   period_days: 30,
 *   metrics: {
 *     nrr: {
 *       value: number | null,
 *       external_benchmark: {
 *         excellent: number, bon: number, correct: number, mediocre: number,
 *         rating: "excellent" | "bon" | "correct" | "médiocre",
 *         sources: string[]
 *       },
 *       peer: {
 *         available: boolean,
 *         median: number | null,
 *         org_count: number | null,
 *         delta: number | null
 *       }
 *     },
 *     churn_rate: { ... },  // même structure
 *     mrr_growth: { ... }   // même structure
 *   }
 * }
 *
 * Erreurs : { error: string } avec status 401/403/404/500
 * 404 : organisation non trouvée ou pas assez de données pour calculer
 * ────────────────────────────────────────────────────────
 */

import { handleCors } from '../_shared/cors.ts'
import { verifyUserAuth } from '../_shared/auth.ts'
import { createServiceClient, jsonResponse, errorResponse } from '../_shared/supabase-client.ts'
import { createLogger } from '../_shared/structured-logger.ts'
import {
  computeNrr,
  computeChurnRate,
  computeMrrGrowth,
  computeNetMovements,
  buildPeerResult,
  buildMetricResult,
  type MrrMovementRow,
  type OrgMetrics,
} from '../_shared/benchmark-helpers.ts'
import { MIN_PEER_ORG_COUNT } from './benchmark-constants.ts'
import { withSentry } from '../_shared/sentry.ts'

Deno.serve(withSentry('get-benchmark-data', async (req: Request) => {
  // CORS
  const corsResp = handleCors(req)
  if (corsResp) return corsResp

  const logger = createLogger({
    correlation_id: crypto.randomUUID(),
    function_name: 'get-benchmark-data',
  })

  try {
    // Auth
    const { organizationId } = await verifyUserAuth(req)
    logger.info('Benchmark request', { organization_id: organizationId })

    const supabase = createServiceClient()
    const now = new Date()
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    const thirtyDaysAgoISO = thirtyDaysAgo.toISOString()
    const ninetyDaysAgoISO = ninetyDaysAgo.toISOString()

    // ── Org courante ─────────────────────────────────────

    // MRR actuel (subscriptions actives)
    const { data: activeSubs, error: subsErr } = await supabase
      .from('subscriptions')
      .select('mrr_cents')
      .eq('organization_id', organizationId)
      .in('status', ['active', 'trialing'])

    if (subsErr) {
      logger.error('subscriptions query failed', { error: subsErr.message })
      return errorResponse('Erreur interne', 500)
    }

    const currentMrrCents = (activeSubs || []).reduce(
      (sum: number, s: { mrr_cents: number }) => sum + (s.mrr_cents || 0),
      0
    )

    // MRR movements 90j (pour NRR)
    const { data: movements90d, error: mov90Err } = await supabase
      .from('mrr_movements')
      .select('movement_type, amount_cents')
      .eq('organization_id', organizationId)
      .gte('movement_date', ninetyDaysAgoISO)

    if (mov90Err) {
      logger.error('mrr_movements 90d query failed', { error: mov90Err.message })
      return errorResponse('Erreur interne', 500)
    }

    // MRR movements 30j (pour MRR Growth)
    const { data: movements30d, error: mov30Err } = await supabase
      .from('mrr_movements')
      .select('movement_type, amount_cents')
      .eq('organization_id', organizationId)
      .gte('movement_date', thirtyDaysAgoISO)

    if (mov30Err) {
      logger.error('mrr_movements 30d query failed', { error: mov30Err.message })
      return errorResponse('Erreur interne', 500)
    }

    // Comptes churned 30j
    const { data: churnedAccounts, error: churnErr } = await supabase
      .from('mrr_movements')
      .select('account_id')
      .eq('organization_id', organizationId)
      .eq('movement_type', 'churn')
      .gte('movement_date', thirtyDaysAgoISO)

    if (churnErr) {
      logger.error('churn count query failed', { error: churnErr.message })
      return errorResponse('Erreur interne', 500)
    }

    // Deduplicate churned account_ids
    const churnedIds = new Set<string>()
    for (const row of churnedAccounts || []) {
      if (row.account_id) churnedIds.add(row.account_id)
    }
    const churnedCount = churnedIds.size

    // Comptes existants il y a 30j (créés avant 30j, actifs ou annulés)
    const { count: startCount, error: startErr } = await supabase
      .from('accounts')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .lt('created_at', thirtyDaysAgoISO)

    if (startErr) {
      logger.error('start count query failed', { error: startErr.message })
      return errorResponse('Erreur interne', 500)
    }

    // Calculs org courante
    const orgNrr = computeNrr(currentMrrCents, (movements90d || []) as MrrMovementRow[])
    const orgChurnRate = computeChurnRate(churnedCount, startCount || 0)
    const netMov30d = computeNetMovements((movements30d || []) as MrrMovementRow[])
    const orgMrrGrowth = computeMrrGrowth(currentMrrCents, netMov30d)

    // 404 si aucune donnée exploitable
    if (orgNrr === null && orgChurnRate === null && orgMrrGrowth === null) {
      logger.info('Insufficient data for benchmark', { organization_id: organizationId })
      return errorResponse('Pas assez de données pour calculer les benchmarks', 404)
    }

    // ── Peer comparison ──────────────────────────────────

    // Compter les orgs actives
    const { data: activeOrgs, error: orgsErr } = await supabase
      .from('organizations')
      .select('id')
      .eq('is_active', true)

    if (orgsErr) {
      logger.error('organizations query failed', { error: orgsErr.message })
      return errorResponse('Erreur interne', 500)
    }

    const orgCount = (activeOrgs || []).length
    let peerNrrValues: (number | null)[] = []
    let peerChurnValues: (number | null)[] = []
    let peerGrowthValues: (number | null)[] = []

    if (orgCount >= MIN_PEER_ORG_COUNT) {
      // Calculer les métriques pour chaque org
      for (const org of activeOrgs || []) {
        const orgId = org.id

        // MRR actuel de l'org
        const { data: peerSubs } = await supabase
          .from('subscriptions')
          .select('mrr_cents')
          .eq('organization_id', orgId)
          .in('status', ['active', 'trialing'])

        const peerMrr = (peerSubs || []).reduce(
          (sum: number, s: { mrr_cents: number }) => sum + (s.mrr_cents || 0),
          0
        )

        // Movements 90j
        const { data: peerMov90 } = await supabase
          .from('mrr_movements')
          .select('movement_type, amount_cents')
          .eq('organization_id', orgId)
          .gte('movement_date', ninetyDaysAgoISO)

        peerNrrValues.push(computeNrr(peerMrr, (peerMov90 || []) as MrrMovementRow[]))

        // Churn 30j
        const { data: peerChurned } = await supabase
          .from('mrr_movements')
          .select('account_id')
          .eq('organization_id', orgId)
          .eq('movement_type', 'churn')
          .gte('movement_date', thirtyDaysAgoISO)

        const peerChurnedIds = new Set<string>()
        for (const row of peerChurned || []) {
          if (row.account_id) peerChurnedIds.add(row.account_id)
        }

        const { count: peerStart } = await supabase
          .from('accounts')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', orgId)
          .lt('created_at', thirtyDaysAgoISO)

        peerChurnValues.push(computeChurnRate(peerChurnedIds.size, peerStart || 0))

        // MRR Growth 30j
        const { data: peerMov30 } = await supabase
          .from('mrr_movements')
          .select('movement_type, amount_cents')
          .eq('organization_id', orgId)
          .gte('movement_date', thirtyDaysAgoISO)

        const peerNet30 = computeNetMovements((peerMov30 || []) as MrrMovementRow[])
        peerGrowthValues.push(computeMrrGrowth(peerMrr, peerNet30))
      }
    }

    // Build response
    const nrrPeer = buildPeerResult(orgNrr, peerNrrValues, orgCount)
    const churnPeer = buildPeerResult(orgChurnRate, peerChurnValues, orgCount)
    const growthPeer = buildPeerResult(orgMrrGrowth, peerGrowthValues, orgCount)

    const response = {
      computed_at: now.toISOString(),
      period_days: 30,
      metrics: {
        nrr: buildMetricResult('nrr', orgNrr, nrrPeer),
        churn_rate: buildMetricResult('churn_rate', orgChurnRate, churnPeer),
        mrr_growth: buildMetricResult('mrr_growth', orgMrrGrowth, growthPeer),
      },
    }

    logger.info('Benchmark computed', {
      organization_id: organizationId,
      nrr: orgNrr,
      churn_rate: orgChurnRate,
      mrr_growth: orgMrrGrowth,
      peer_available: orgCount >= MIN_PEER_ORG_COUNT,
    })

    return jsonResponse(response)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    const status = (err as { status?: number }).status || 500
    logger.error('Benchmark error', { error: message, status })
    return errorResponse(message, status)
  }
}))
