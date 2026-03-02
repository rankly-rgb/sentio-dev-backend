// ============================================================
// Edge Function : calculate-scores
// Calcule quotidiennement les scores Health/Churn/Expansion
// pour chaque account et persiste dans score_history.
//
// Formules (CLAUDE.md) :
//   Health  = (Usage×35%) + (Financial×25%) + (Engagement×20%) + (Contract×20%)
//   Churn   = 100 - Health + facteurs additifs (capped 100)
//   Expansion = (seat_usage_pct×60%) + (feature_ceiling×40%)
// ============================================================
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { DataSyncLogger } from '../_shared/data-sync-logger.ts'
import { acquireCronLock, releaseCronLock } from '../_shared/cron-lock.ts'
import { alertSlack } from '../_shared/slack-alert.ts'
import {
  type Account,
  type UsageStats,
  type HubspotData,
  type InvoiceStatus,
  calcUsageScore,
  calcFinancialScore,
  calcEngagementScore,
  calcContractScore,
  calcExpansionScore,
} from '../_shared/scoring.ts'

// ── Scoring d'un compte ───────────────────────────────────────
async function scoreAccount(
  supabase: SupabaseClient,
  account: Account,
  maxMrrCents: number,
  snapshotDate: string,
): Promise<{
  health_score: number
  churn_risk_score: number
  expansion_score: number
  product_usage_score: number
}> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]

  // Usage stats (30 derniers jours)
  const { data: usageRows } = await supabase
    .from('usage_events')
    .select('event_type, feature_name, event_count, event_date')
    .eq('account_id', account.id)
    .gte('event_date', thirtyDaysAgo)

  const stats: UsageStats = {
    login_count: 0,
    feature_count: 0,
    total_events: 0,
    distinct_features: 0,
    days_active: 0,
  }

  if (usageRows && usageRows.length > 0) {
    const features = new Set<string>()
    const dates = new Set<string>()
    for (const row of usageRows) {
      stats.total_events += row.event_count ?? 1
      if (row.event_type === 'login') stats.login_count += row.event_count ?? 1
      if (row.event_type === 'feature_used') {
        stats.feature_count += row.event_count ?? 1
        if (row.feature_name) features.add(row.feature_name)
      }
      if (row.event_date) dates.add(row.event_date)
    }
    stats.distinct_features = features.size
    stats.days_active = dates.size
  }

  // HubSpot data
  const { data: hubspotRow } = await supabase
    .from('hubspot_companies')
    .select('nps_score, open_ticket_count, open_deal_count, last_meeting_date')
    .eq('account_id', account.id)
    .single()

  const hubspot: HubspotData | null = hubspotRow ?? null

  // Status factures (impayées)
  const { data: overdueInvoices } = await supabase
    .from('invoices')
    .select('id')
    .eq('account_id', account.id)
    .in('status', ['open', 'uncollectible'])

  const invoiceStatus: InvoiceStatus = {
    has_overdue: (overdueInvoices?.length ?? 0) > 0,
    overdue_count: overdueInvoices?.length ?? 0,
  }

  // Calcul des composantes
  const usageScore = calcUsageScore(stats)
  const financialScore = calcFinancialScore(account.mrr_cents, invoiceStatus, maxMrrCents)
  const engagementScore = calcEngagementScore(hubspot)
  const contractScore = calcContractScore(account)

  const healthScore = Math.round(
    (usageScore * 0.35 + financialScore * 0.25 + engagementScore * 0.20 + contractScore * 0.20) * 100,
  ) / 100

  // Facteurs additifs de churn risk
  let churnAdditif = 0
  if (invoiceStatus.has_overdue) churnAdditif += 15
  if (stats.days_active === 0) churnAdditif += 20 // aucune activité depuis 30j
  if (account.contract_end_date) {
    const daysUntilRenewal = Math.floor(
      (new Date(account.contract_end_date).getTime() - Date.now()) / 86400000,
    )
    if (daysUntilRenewal <= 30 && daysUntilRenewal >= 0) churnAdditif += 10
    if (daysUntilRenewal < 0) churnAdditif += 25 // contrat expiré
  }

  const churnRiskScore = Math.min(100, Math.round((100 - healthScore + churnAdditif) * 100) / 100)
  const expansionScore = calcExpansionScore(account, stats)

  return {
    health_score: Math.max(0, Math.min(100, healthScore)),
    churn_risk_score: Math.max(0, Math.min(100, churnRiskScore)),
    expansion_score: Math.max(0, Math.min(100, expansionScore)),
    product_usage_score: Math.max(0, Math.min(100, usageScore)),
  }
}

// ── Entrypoint ───────────────────────────────────────────────
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
    console.error(JSON.stringify({ level: 'error', function_name: 'calculate-scores', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  let body: { organization_id?: string; snapshot_date?: string } = {}
  try {
    body = await req.json()
  } catch {
    // Body optionnel
  }

  const snapshotDate = body.snapshot_date ?? new Date().toISOString().split('T')[0]

  // Résoudre les organisations à traiter
  let orgQuery = supabase
    .from('organizations')
    .select('id')
    .eq('is_active', true)

  if (body.organization_id) {
    orgQuery = orgQuery.eq('id', body.organization_id)
  }

  const { data: orgs, error: orgError } = await orgQuery
  if (orgError || !orgs?.length) {
    return errorResponse('No active organizations found', 404)
  }

  // Acquire cron lock to prevent concurrent scoring runs
  const lockAcquired = await acquireCronLock(supabase, 'calculate-scores', 300)
  if (!lockAcquired) {
    return errorResponse('Scoring already in progress', 409)
  }

  const results: Array<{ organization_id: string; accounts_scored: number; errors: number }> = []

  try {
    for (const org of orgs) {
      const organizationId = org.id
      let accountsScored = 0
      let errors = 0

      const logger = new DataSyncLogger({
        supabase,
        organizationId,
        syncSource: 'manual',
        syncType: 'daily',
        triggeredBy: 'cron',
      })
      await logger.start()

      try {
        // Récupérer le MRR max de l'org (pour normalisation relative)
        const { data: maxMrrRow } = await supabase
          .from('accounts')
          .select('mrr_cents')
          .eq('organization_id', organizationId)
          .order('mrr_cents', { ascending: false })
          .limit(1)
          .single()

        const maxMrrCents = maxMrrRow?.mrr_cents ?? 1

        // Récupérer tous les accounts actifs de l'org
        const { data: accounts } = await supabase
          .from('accounts')
          .select('id, organization_id, mrr_cents, seat_count, seat_limit, contract_end_date, health_score, churn_risk_score')
          .eq('organization_id', organizationId)

        if (!accounts?.length) {
          await logger.complete({ accounts_scored: 0 })
          continue
        }

        for (const account of accounts as Account[]) {
          try {
            const scores = await scoreAccount(supabase, account, maxMrrCents, snapshotDate)

            // Upsert dans score_history
            await supabase
              .from('score_history')
              .upsert(
                {
                  organization_id: organizationId,
                  account_id: account.id,
                  snapshot_date: snapshotDate,
                  health_score: scores.health_score,
                  churn_risk_score: scores.churn_risk_score,
                  expansion_score: scores.expansion_score,
                  product_usage_score: scores.product_usage_score,
                  mrr_cents: account.mrr_cents ?? 0,
                },
                { onConflict: 'organization_id,account_id,snapshot_date', ignoreDuplicates: false },
              )

            // Mettre à jour les scores courants sur l'account
            await supabase
              .from('accounts')
              .update({
                health_score: scores.health_score,
                churn_risk_score: scores.churn_risk_score,
                expansion_score: scores.expansion_score,
                product_usage_score: scores.product_usage_score,
                scores_calculated_at: new Date().toISOString(),
              })
              .eq('id', account.id)

            accountsScored++
            logger.increment('records_processed')
          } catch (err) {
            console.error(JSON.stringify({
              level: 'error',
              function_name: 'calculate-scores',
              organization_id: organizationId,
              account_id: account.id,
              message: err instanceof Error ? err.message : String(err),
            }))
            errors++
            logger.increment('records_failed')
          }
        }

        await logger.complete({ accounts_scored: accountsScored, errors })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await logger.fail(msg)
        errors = -1
      }

      results.push({ organization_id: organizationId, accounts_scored: accountsScored, errors })
    }

    return jsonResponse({
      success: true,
      snapshot_date: snapshotDate,
      organizations_processed: orgs.length,
      results,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'calculate-scores',
      message: msg,
    }))

    await alertSlack(
      `calculate-scores failed: ${msg}`,
      { level: 'critical' },
    )

    return errorResponse(`Scoring failed: ${msg}`, 500)
  } finally {
    await releaseCronLock(supabase, 'calculate-scores')
  }
})
