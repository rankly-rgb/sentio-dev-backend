// ============================================================
// Edge Function : calculate-scores
// Calcule quotidiennement les scores Health/Churn/Expansion
// pour chaque account, assigne les segments, et persiste
// dans score_history + account_segments.
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
  type SegmentType,
  SYSTEM_SEGMENT_TYPES,
  calcUsageScore,
  calcFinancialScore,
  calcEngagementScore,
  calcContractScore,
  calcExpansionScore,
  calcHealthScore,
  calcChurnRiskScore,
  determineSegmentTypes,
} from '../_shared/scoring.ts'

// ── Types internes ──────────────────────────────────────────
interface AccountWithCreatedAt extends Account {
  created_at: string
}

interface ScoreResult {
  health_score: number
  churn_risk_score: number
  expansion_score: number
  product_usage_score: number
}

// ── Segment definitions (mirrored in migration) ─────────────
const SEGMENT_DEFINITIONS: Array<{
  segment_name: string
  segment_type: SegmentType
  priority: string
  criteria: Record<string, unknown>
  description: string
}> = [
  { segment_name: 'Champions', segment_type: 'champions', priority: 'high', criteria: { health_score_gte: 80 }, description: 'Comptes en excellente sante' },
  { segment_name: 'En expansion', segment_type: 'en_expansion', priority: 'medium', criteria: { expansion_score_gte: 70, health_score_gte: 60 }, description: "Comptes avec potentiel d'expansion" },
  { segment_name: 'Stables', segment_type: 'stables', priority: 'low', criteria: { health_score_gte: 40, churn_risk_lt: 50 }, description: 'Comptes stables sans risque' },
  { segment_name: 'A risque leger', segment_type: 'a_risque_leger', priority: 'medium', criteria: { churn_risk_gte: 50, churn_risk_lt: 70 }, description: 'Comptes montrant des signes de risque' },
  { segment_name: 'En danger critique', segment_type: 'en_danger_critique', priority: 'critical', criteria: { churn_risk_gte: 70 }, description: 'Comptes en danger imminent de churn' },
  { segment_name: 'Impayes', segment_type: 'impayes', priority: 'critical', criteria: { has_overdue_invoices: true }, description: 'Comptes avec factures impayees' },
  { segment_name: 'En churn', segment_type: 'en_churn', priority: 'critical', criteria: { mrr_cents_eq: 0 }, description: 'Comptes ayant churne' },
  { segment_name: 'Nouveaux (< 90j)', segment_type: 'nouveaux', priority: 'low', criteria: { days_since_creation_lt: 90 }, description: 'Comptes crees il y a moins de 90 jours' },
]

// ── Ensure system segments exist for an org ──────────────────
async function ensureSystemSegments(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<Map<SegmentType, string>> {
  const { data: existing } = await supabase
    .from('account_segments')
    .select('id, segment_type')
    .eq('organization_id', organizationId)
    .eq('is_system_generated', true)

  const segmentMap = new Map<SegmentType, string>()
  const existingTypes = new Set<string>()

  for (const seg of existing ?? []) {
    segmentMap.set(seg.segment_type as SegmentType, seg.id)
    existingTypes.add(seg.segment_type)
  }

  const missing = SEGMENT_DEFINITIONS.filter((d) => !existingTypes.has(d.segment_type))

  if (missing.length > 0) {
    const { data: created } = await supabase
      .from('account_segments')
      .insert(
        missing.map((d) => ({
          organization_id: organizationId,
          segment_name: d.segment_name,
          segment_type: d.segment_type,
          priority: d.priority,
          criteria: d.criteria,
          description: d.description,
          is_system_generated: true,
          is_active: true,
        })),
      )
      .select('id, segment_type')

    for (const seg of created ?? []) {
      segmentMap.set(seg.segment_type as SegmentType, seg.id)
    }
  }

  return segmentMap
}

// ── Batch size for paginated scoring ────────────────────────────
const SCORING_BATCH_SIZE = 500
const MAX_BATCHES = 200 // Safety guard: 200 * 500 = 100k accounts max per org

const DEFAULT_USAGE: UsageStats = { login_count: 0, feature_count: 0, total_events: 0, distinct_features: 0, days_active: 0 }
const DEFAULT_INVOICE: InvoiceStatus = { has_overdue: false, overdue_count: 0 }

// ── Pre-fetch scoring data for a batch of accounts (3 parallel queries instead of 3N) ──
async function prefetchScoringData(
  supabase: SupabaseClient,
  accountIds: string[],
): Promise<{
  usageMap: Map<string, UsageStats>
  hubspotMap: Map<string, HubspotData | null>
  invoiceStatusMap: Map<string, InvoiceStatus>
}> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]

  const [usageResult, hubspotResult, invoiceResult] = await Promise.all([
    supabase
      .from('usage_events')
      .select('account_id, event_type, feature_name, event_count, event_date')
      .in('account_id', accountIds)
      .gte('event_date', thirtyDaysAgo)
      .limit(50000),
    supabase
      .from('hubspot_companies')
      .select('account_id, nps_score, open_ticket_count, open_deal_count, last_meeting_date')
      .in('account_id', accountIds),
    supabase
      .from('invoices')
      .select('account_id')
      .in('account_id', accountIds)
      .in('status', ['open', 'uncollectible']),
  ])

  // Build usage stats per account
  const usageMap = new Map<string, UsageStats>()
  if (usageResult.data) {
    const grouped = new Map<string, Array<Record<string, unknown>>>()
    for (const row of usageResult.data) {
      const list = grouped.get(row.account_id) ?? []
      list.push(row)
      grouped.set(row.account_id, list)
    }
    for (const [accountId, rows] of grouped) {
      const stats: UsageStats = { login_count: 0, feature_count: 0, total_events: 0, distinct_features: 0, days_active: 0 }
      const features = new Set<string>()
      const dates = new Set<string>()
      for (const row of rows) {
        const count = (row.event_count as number) ?? 1
        stats.total_events += count
        if (row.event_type === 'login') stats.login_count += count
        if (row.event_type === 'feature_used') {
          stats.feature_count += count
          if (row.feature_name) features.add(row.feature_name as string)
        }
        if (row.event_date) dates.add(row.event_date as string)
      }
      stats.distinct_features = features.size
      stats.days_active = dates.size
      usageMap.set(accountId, stats)
    }
  }

  // Build hubspot data map
  const hubspotMap = new Map<string, HubspotData | null>()
  if (hubspotResult.data) {
    for (const row of hubspotResult.data) {
      hubspotMap.set(row.account_id, row as unknown as HubspotData)
    }
  }

  // Build invoice status map
  const invoiceStatusMap = new Map<string, InvoiceStatus>()
  if (invoiceResult.data) {
    const counts = new Map<string, number>()
    for (const row of invoiceResult.data) {
      counts.set(row.account_id, (counts.get(row.account_id) ?? 0) + 1)
    }
    for (const [accountId, count] of counts) {
      invoiceStatusMap.set(accountId, { has_overdue: true, overdue_count: count })
    }
  }

  return { usageMap, hubspotMap, invoiceStatusMap }
}

// ── Scoring d'un compte (pure — no DB calls) ────────────────────
function scoreAccountPure(
  account: Account,
  maxMrrCents: number,
  usage: UsageStats,
  hubspot: HubspotData | null,
  invoiceStatus: InvoiceStatus,
): ScoreResult & { invoiceStatus: InvoiceStatus; daysActive: number } {
  const usageScore = calcUsageScore(usage)
  const financialScore = calcFinancialScore(account.mrr_cents, invoiceStatus, maxMrrCents)
  const engagementScore = calcEngagementScore(hubspot)
  const contractScore = calcContractScore(account)

  const healthScore = calcHealthScore(usageScore, financialScore, engagementScore, contractScore)
  const churnRiskScore = calcChurnRiskScore(healthScore, invoiceStatus, usage.days_active, account)
  const expansionScore = calcExpansionScore(account, usage)

  return {
    health_score: Math.max(0, Math.min(100, healthScore)),
    churn_risk_score: Math.max(0, Math.min(100, churnRiskScore)),
    expansion_score: Math.max(0, Math.min(100, expansionScore)),
    product_usage_score: Math.max(0, Math.min(100, usageScore)),
    invoiceStatus,
    daysActive: usage.days_active,
  }
}

// ── Assign segments after scoring ────────────────────────────
async function assignSegments(
  supabase: SupabaseClient,
  organizationId: string,
  accounts: AccountWithCreatedAt[],
  accountScores: Map<string, ScoreResult>,
  accountInvoiceStatus: Map<string, InvoiceStatus>,
): Promise<{ segmentsAssigned: number }> {
  const segmentMap = await ensureSystemSegments(supabase, organizationId)
  const systemSegmentIds = Array.from(segmentMap.values())

  if (systemSegmentIds.length === 0) return { segmentsAssigned: 0 }

  // Build new memberships (upsert to avoid delete+insert visibility gap)
  const memberships: Array<Record<string, unknown>> = []
  const segmentAggs: Record<string, { count: number; mrrTotal: number; healthSum: number; churnSum: number }> = {}

  for (const segType of SYSTEM_SEGMENT_TYPES) {
    segmentAggs[segType] = { count: 0, mrrTotal: 0, healthSum: 0, churnSum: 0 }
  }

  const now = new Date().toISOString()

  for (const account of accounts) {
    const scores = accountScores.get(account.id)
    if (!scores) continue

    const invoiceStatus = accountInvoiceStatus.get(account.id)
    const hasOverdue = invoiceStatus?.has_overdue ?? false

    const segTypes = determineSegmentTypes(
      scores,
      account.mrr_cents ?? 0,
      hasOverdue,
      account.created_at,
    )

    for (const segType of segTypes) {
      const segId = segmentMap.get(segType)
      if (!segId) continue

      memberships.push({
        organization_id: organizationId,
        segment_id: segId,
        account_id: account.id,
        status: 'active',
        source_type: 'ai_generated',
        risk_score: scores.churn_risk_score,
        last_evaluated_at: now,
      })

      segmentAggs[segType].count++
      segmentAggs[segType].mrrTotal += account.mrr_cents ?? 0
      segmentAggs[segType].healthSum += scores.health_score
      segmentAggs[segType].churnSum += scores.churn_risk_score
    }
  }

  // Batch upsert memberships (atomic — no visibility gap)
  const newAccountSegmentPairs = new Set<string>()
  if (memberships.length > 0) {
    const CHUNK_SIZE = 100
    for (let i = 0; i < memberships.length; i += CHUNK_SIZE) {
      const { error } = await supabase
        .from('segment_memberships')
        .upsert(memberships.slice(i, i + CHUNK_SIZE), {
          onConflict: 'organization_id,segment_id,account_id',
          ignoreDuplicates: false,
        })

      if (error) {
        console.error('[calculate-scores] segment_memberships upsert error:', error.message)
      }
    }
    for (const m of memberships) {
      newAccountSegmentPairs.add(`${m.account_id}:${m.segment_id}`)
    }
  }

  // Clean up stale memberships that are no longer valid
  const { data: existingMemberships } = await supabase
    .from('segment_memberships')
    .select('id, account_id, segment_id')
    .eq('organization_id', organizationId)
    .eq('source_type', 'ai_generated')
    .in('segment_id', systemSegmentIds)

  const staleIds = (existingMemberships ?? [])
    .filter((m: Record<string, unknown>) => !newAccountSegmentPairs.has(`${m.account_id}:${m.segment_id}`))
    .map((m: Record<string, unknown>) => m.id as string)

  if (staleIds.length > 0) {
    const { error: deleteError } = await supabase
      .from('segment_memberships')
      .delete()
      .in('id', staleIds)

    if (deleteError) {
      console.error('[calculate-scores] stale membership cleanup error:', deleteError.message)
    }
  }

  // Update segment aggregate metrics
  for (const [segType, agg] of Object.entries(segmentAggs)) {
    const segId = segmentMap.get(segType as SegmentType)
    if (!segId) continue

    await supabase
      .from('account_segments')
      .update({
        account_count: agg.count,
        mrr_total_cents: agg.mrrTotal,
        avg_health_score: agg.count > 0 ? Math.round((agg.healthSum / agg.count) * 100) / 100 : null,
        avg_churn_risk: agg.count > 0 ? Math.round((agg.churnSum / agg.count) * 100) / 100 : null,
        last_calculated_at: now,
      })
      .eq('id', segId)
  }

  return { segmentsAssigned: memberships.length }
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

  const results: Array<{ organization_id: string; accounts_scored: number; segments_assigned: number; errors: number }> = []

  try {
    for (const org of orgs) {
      const organizationId = org.id
      let accountsScored = 0
      let segmentsAssigned = 0
      let errors = 0

      const logger = new DataSyncLogger({
        supabase,
        organizationId,
        syncSource: 'scoring',
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
          .maybeSingle()

        const maxMrrCents = maxMrrRow?.mrr_cents || 1

        // Scorer les accounts par batch paginé (évite OOM et timeout N+1)
        const accountScores = new Map<string, ScoreResult>()
        const accountInvoiceStatus = new Map<string, InvoiceStatus>()
        const allAccounts: AccountWithCreatedAt[] = []
        let batchOffset = 0
        let batchFailed = false
        let batchCount = 0

        while (batchCount < MAX_BATCHES) {
          batchCount++
          const { data: batch, error: batchError } = await supabase
            .from('accounts')
            .select('id, organization_id, mrr_cents, seat_count, seat_limit, contract_end_date, health_score, churn_risk_score, created_at')
            .eq('organization_id', organizationId)
            .range(batchOffset, batchOffset + SCORING_BATCH_SIZE - 1)

          if (batchError) {
            console.error(JSON.stringify({
              level: 'error',
              function_name: 'calculate-scores',
              organization_id: organizationId,
              message: `accounts query failed at offset ${batchOffset}: ${batchError.message}`,
            }))
            if (batchOffset === 0) {
              await logger.fail(batchError.message)
              batchFailed = true
            }
            break
          }

          if (!batch?.length) break

          allAccounts.push(...(batch as AccountWithCreatedAt[]))

          // Pre-fetch all scoring data in 3 parallel bulk queries (instead of 3N sequential)
          const batchIds = batch.map((a: { id: string }) => a.id)
          const { usageMap, hubspotMap, invoiceStatusMap } = await prefetchScoringData(supabase, batchIds)

          // Score each account (pure — no DB calls)
          const historyRows: Array<Record<string, unknown>> = []

          for (const account of batch as AccountWithCreatedAt[]) {
            try {
              const usage = usageMap.get(account.id) ?? DEFAULT_USAGE
              const hubspot = hubspotMap.get(account.id) ?? null
              const invoiceStatus = invoiceStatusMap.get(account.id) ?? DEFAULT_INVOICE

              const result = scoreAccountPure(account, maxMrrCents, usage, hubspot, invoiceStatus)
              const scores: ScoreResult = {
                health_score: result.health_score,
                churn_risk_score: result.churn_risk_score,
                expansion_score: result.expansion_score,
                product_usage_score: result.product_usage_score,
              }

              accountScores.set(account.id, scores)
              accountInvoiceStatus.set(account.id, result.invoiceStatus)

              historyRows.push({
                organization_id: organizationId,
                account_id: account.id,
                snapshot_date: snapshotDate,
                health_score: scores.health_score,
                churn_risk_score: scores.churn_risk_score,
                expansion_score: scores.expansion_score,
                product_usage_score: scores.product_usage_score,
                mrr_cents: account.mrr_cents ?? 0,
              })

              // Update account current scores
              const { error: updateError } = await supabase
                .from('accounts')
                .update({
                  health_score: scores.health_score,
                  churn_risk_score: scores.churn_risk_score,
                  expansion_score: scores.expansion_score,
                  product_usage_score: scores.product_usage_score,
                  scores_calculated_at: new Date().toISOString(),
                })
                .eq('id', account.id)

              if (updateError) {
                console.error(JSON.stringify({
                  level: 'error',
                  function_name: 'calculate-scores',
                  organization_id: organizationId,
                  account_id: account.id,
                  message: `accounts update failed: ${updateError.message}`,
                }))
                errors++
                logger.increment('records_failed')
                continue
              }

              accountsScored++
              logger.increment('records_processed')
            } catch (err) {
              console.error(JSON.stringify({
                level: 'error',
                function_name: 'calculate-scores',
                organization_id: organizationId,
                account_id: (account as { id: string }).id,
                message: err instanceof Error ? err.message : String(err),
              }))
              errors++
              logger.increment('records_failed')
            }
          }

          // Batch upsert score_history for this batch
          if (historyRows.length > 0) {
            const { error: historyError } = await supabase
              .from('score_history')
              .upsert(historyRows, { onConflict: 'organization_id,account_id,snapshot_date', ignoreDuplicates: false })

            if (historyError) {
              console.error(JSON.stringify({
                level: 'error',
                function_name: 'calculate-scores',
                organization_id: organizationId,
                message: `score_history batch upsert failed: ${historyError.message}`,
              }))
            }
          }

          // If batch was smaller than page size, we've reached the end
          if (batch.length < SCORING_BATCH_SIZE) break
          batchOffset += batch.length
        }

        if (batchFailed) continue

        if (allAccounts.length === 0) {
          await logger.complete({ accounts_scored: 0, segments_assigned: 0 })
          continue
        }

        // ── Segment Assignment ──────────────────────────────
        try {
          const segResult = await assignSegments(
            supabase,
            organizationId,
            allAccounts,
            accountScores,
            accountInvoiceStatus,
          )
          segmentsAssigned = segResult.segmentsAssigned
        } catch (err) {
          console.error(JSON.stringify({
            level: 'error',
            function_name: 'calculate-scores',
            organization_id: organizationId,
            message: `segment assignment failed: ${err instanceof Error ? err.message : String(err)}`,
          }))
        }

        await logger.complete({ accounts_scored: accountsScored, segments_assigned: segmentsAssigned, errors })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await logger.fail(msg)
        errors++
      }

      results.push({ organization_id: organizationId, accounts_scored: accountsScored, segments_assigned: segmentsAssigned, errors })
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
