// ============================================================
// Edge Function : generate-insights
// Génère quotidiennement des insights IA basés sur les scores
// et données de chaque account, avec déduplication et
// auto-résolution.
//
// Trigger : cron (service_role HS256)
// Pattern : acquireCronLock → par org → batch accounts →
//           evaluateInsightRules → upsert/auto-resolve → release
// ============================================================
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { DataSyncLogger } from '../_shared/data-sync-logger.ts'
import { acquireCronLock, releaseCronLock } from '../_shared/cron-lock.ts'
import { alertSlack } from '../_shared/slack-alert.ts'
import {
  type InsightInput,
  type InsightCandidate,
  evaluateInsightRules,
} from '../_shared/insight-rules.ts'
import { withSentry } from '../_shared/sentry.ts'

// ── Constants ────────────────────────────────────────────────
const LOCK_TTL_SECONDS = 300
const BATCH_SIZE = 500
const MAX_BATCHES = 200
// Per-org isolation timeout (2026-08-23) — this cron never got the P1 fix
// (2026-08-13, PR #61) that calculate-scores/sync-stripe received: nothing
// here stops one slow org's sequential per-account syncInsights() calls from
// running long enough to push the whole cron invocation past self-monitor's
// 15-minute external sweep. Same value and same cooperative-check design
// (issue #65 — a passive setTimeout/Promise.race can be starved by a long
// chain of awaited microtasks and never fire) as calculate-scores.
const ORG_INSIGHTS_TIMEOUT_MS = 90_000

// ── Types ────────────────────────────────────────────────────
interface AccountRow {
  id: string
  organization_id: string
  health_score: number | null
  churn_risk_score: number | null
  churn_risk_band: string | null
  expansion_score: number | null
  product_usage_score: number | null
  mrr_cents: number | null
  contract_end_date: string | null
  created_at: string
  is_delinquent: boolean
}

// ── Pre-fetch data needed for insight evaluation ─────────────
async function prefetchInsightData(
  supabase: SupabaseClient,
  accountIds: string[],
): Promise<{
  invoiceMap: Map<string, { has_overdue: boolean; overdue_days: number }>
  usageHistoryMap: Map<string, number>
}> {
  const now = new Date()
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000).toISOString().split('T')[0]

  const [invoiceResult, usageHistoryResult] = await Promise.all([
    // Factures impayées avec date la plus ancienne
    supabase
      .from('invoices')
      .select('account_id, due_date')
      .in('account_id', accountIds)
      .in('status', ['open', 'uncollectible'])
      .order('due_date', { ascending: true })
      .limit(5000),
    // Score usage d'il y a 14 jours (pour détecter usage_drop)
    supabase
      .from('score_history')
      .select('account_id, product_usage_score, snapshot_date')
      .in('account_id', accountIds)
      .lte('snapshot_date', fourteenDaysAgo)
      .order('snapshot_date', { ascending: false })
      .limit(5000),
  ])

  // Build invoice map (oldest overdue per account)
  const invoiceMap = new Map<string, { has_overdue: boolean; overdue_days: number }>()
  if (invoiceResult.data) {
    for (const row of invoiceResult.data) {
      if (invoiceMap.has(row.account_id)) continue // oldest first
      const dueDate = new Date(row.due_date)
      const overdueDays = Math.max(0, Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)))
      invoiceMap.set(row.account_id, { has_overdue: true, overdue_days: overdueDays })
    }
  }

  // Build usage history map (most recent score ~14 days ago per account).
  // Note (2026-08-04, AUDIT_LOGIQUE_METIER_STRIPE.md point 19) : ce map
  // n'est plus consommé par aucune règle active — evaluateUsageDrop est
  // gelée (_shared/insight-rules.ts) tant que product_usage_score reste
  // une dimension retirée du modèle v3. Conservé et corrigé pour une
  // réactivation propre le jour où une vraie dimension usage v3 existe,
  // plutôt que retiré silencieusement.
  //
  // Bug corrigé : la boucle marquait un compte "visité" uniquement quand
  // une valeur non-nulle était trouvée — un compte dont la ligne la plus
  // récente avait product_usage_score=null retombait alors sur une ligne
  // plus ancienne (potentiellement vieille de plusieurs mois), lue comme
  // si elle datait de ~14 jours. `visitedAccounts` marque désormais le
  // compte dès la première ligne rencontrée (la plus récente, tri
  // snapshot_date DESC), null ou pas — jamais de retombée sur une valeur
  // périmée.
  const usageHistoryMap = new Map<string, number>()
  const visitedAccounts = new Set<string>()
  if (usageHistoryResult.data) {
    for (const row of usageHistoryResult.data) {
      if (visitedAccounts.has(row.account_id)) continue
      visitedAccounts.add(row.account_id)
      if (row.product_usage_score !== null) {
        usageHistoryMap.set(row.account_id, row.product_usage_score)
      }
    }
  }

  return { invoiceMap, usageHistoryMap }
}

// ── Build InsightInput from account data ─────────────────────
function buildInsightInput(
  account: AccountRow,
  invoiceData: { has_overdue: boolean; overdue_days: number } | undefined,
  usagePrevious: number | undefined,
): InsightInput {
  return {
    account_id: account.id,
    organization_id: account.organization_id,
    health_score: account.health_score ?? 50,
    churn_risk_score: account.churn_risk_score ?? 0,
    expansion_score: account.expansion_score ?? 0,
    mrr_cents: account.mrr_cents ?? 0,
    contract_end_date: account.contract_end_date,
    has_overdue_invoices: invoiceData?.has_overdue ?? false,
    overdue_days: invoiceData?.overdue_days ?? 0,
    is_delinquent: account.is_delinquent,
    usage_score_current: account.product_usage_score ?? 50,
    usage_score_previous: usagePrevious ?? null,
    created_at: account.created_at,
  }
}

// ── Sync insights: create/update/auto-resolve ────────────────
// Note: PostgREST upsert does NOT support partial unique indexes,
// so we use manual select → insert/update instead.
async function syncInsights(
  supabase: SupabaseClient,
  organizationId: string,
  accountId: string,
  candidates: InsightCandidate[],
): Promise<{ created: number; resolved: number }> {
  const now = new Date().toISOString()
  let created = 0
  let resolved = 0

  // Active insight types produced by rules
  const activeTypes = new Set(candidates.map((c) => c.insight_type))

  // Fetch existing active insights for this account
  const { data: existingInsights } = await supabase
    .from('ai_insights')
    .select('id, insight_type')
    .eq('organization_id', organizationId)
    .eq('account_id', accountId)
    .eq('status', 'active')

  const existingByType = new Map<string, string>()
  for (const ins of existingInsights ?? []) {
    existingByType.set(ins.insight_type, ins.id)
  }

  // For each candidate: update if active insight exists, insert otherwise
  for (const candidate of candidates) {
    const existingId = existingByType.get(candidate.insight_type)

    if (existingId) {
      // Update existing active insight with fresh data
      const { error } = await supabase
        .from('ai_insights')
        .update({
          title: candidate.title,
          description: candidate.description,
          recommended_action: candidate.recommended_action,
          priority: candidate.priority,
          // confidence_score toujours null (S5) — règles déterministes, pas de
          // probabilité. severity/signals (metadata) la remplacent.
          confidence_score: candidate.confidence_score,
          mrr_impact_cents: candidate.mrr_impact_cents,
          source_scores: candidate.source_scores,
          metadata: { severity: candidate.severity, signals: candidate.signals },
          ai_model_version: 'rules-v1',
        })
        .eq('id', existingId)

      if (error) {
        console.error(JSON.stringify({
          level: 'error',
          function_name: 'generate-insights',
          organization_id: organizationId,
          account_id: accountId,
          message: `insight update failed (${candidate.insight_type}): ${error.message}`,
        }))
      } else {
        created++ // counted as "processed" even if updated
      }
    } else {
      // Insert new insight
      const { error } = await supabase
        .from('ai_insights')
        .insert({
          organization_id: organizationId,
          account_id: accountId,
          insight_type: candidate.insight_type,
          title: candidate.title,
          description: candidate.description,
          recommended_action: candidate.recommended_action,
          priority: candidate.priority,
          confidence_score: candidate.confidence_score,
          mrr_impact_cents: candidate.mrr_impact_cents,
          source_scores: candidate.source_scores,
          metadata: { severity: candidate.severity, signals: candidate.signals },
          status: 'active',
          ai_model_version: 'rules-v1',
        })

      if (error) {
        console.error(JSON.stringify({
          level: 'error',
          function_name: 'generate-insights',
          organization_id: organizationId,
          account_id: accountId,
          message: `insight insert failed (${candidate.insight_type}): ${error.message}`,
        }))
      } else {
        created++
      }
    }
  }

  // Auto-resolve active insights whose condition has disappeared
  const toResolve = (existingInsights ?? []).filter(
    (ins: { insight_type: string }) => !activeTypes.has(ins.insight_type as InsightCandidate['insight_type']),
  )

  if (toResolve.length > 0) {

    for (const ins of toResolve) {
      const { error } = await supabase
        .from('ai_insights')
        .update({ status: 'resolved', resolved_at: now })
        .eq('id', ins.id)

      if (!error) resolved++
    }
  }

  return { created, resolved }
}

// ── Entrypoint ───────────────────────────────────────────────
Deno.serve(withSentry('generate-insights', async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  let supabase: SupabaseClient
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'generate-insights', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  // Optional: target a specific org
  let body: { organization_id?: string } = {}
  try {
    body = await req.json()
  } catch {
    // Body optionnel
  }

  // Resolve orgs
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

  const results: Array<{
    organization_id: string
    insights_created: number
    insights_resolved: number
    accounts_evaluated: number
    errors: number
    timed_out?: boolean
  }> = []

  try {
    for (const org of orgs) {
      const organizationId = org.id
      const orgStartedAt = Date.now()
      // Per-org lock: allows parallel calls from calculate-scores (one per org)
      const lockKey = `generate-insights:${organizationId}`
      const lockAcquired = await acquireCronLock(supabase, lockKey, LOCK_TTL_SECONDS)
      if (!lockAcquired) {
        results.push({ organization_id: organizationId, insights_created: 0, insights_resolved: 0, accounts_evaluated: 0, errors: 0 })
        continue
      }

      let insightsCreated = 0
      let insightsResolved = 0
      let accountsEvaluated = 0
      let errors = 0
      let timedOut = false

      const logger = new DataSyncLogger({
        supabase,
        organizationId,
        syncSource: 'insights',
        syncType: 'daily',
        triggeredBy: 'cron',
      })
      await logger.start()

      try {
        let batchOffset = 0
        let batchCount = 0

        while (batchCount < MAX_BATCHES) {
          // Per-org isolation timeout (2026-08-23, see ORG_INSIGHTS_TIMEOUT_MS
          // above) — checked inline before starting another batch, cooperative
          // rather than a passive timer (issue #65).
          if (Date.now() - orgStartedAt > ORG_INSIGHTS_TIMEOUT_MS) {
            timedOut = true
            break
          }
          batchCount++

          const { data: batch, error: batchError } = await supabase
            .from('accounts')
            .select('id, organization_id, health_score, churn_risk_score, churn_risk_band, expansion_score, product_usage_score, mrr_cents, contract_end_date, created_at, is_delinquent')
            .eq('organization_id', organizationId)
            .not('scores_calculated_at', 'is', null)
            .range(batchOffset, batchOffset + BATCH_SIZE - 1)

          if (batchError) {
            console.error(JSON.stringify({
              level: 'error',
              function_name: 'generate-insights',
              organization_id: organizationId,
              message: `accounts query failed at offset ${batchOffset}: ${batchError.message}`,
            }))
            if (batchOffset === 0) {
              await logger.fail(batchError.message)
            }
            break
          }

          if (!batch?.length) break

          // Pre-fetch invoice + usage history data
          const batchIds = batch.map((a: { id: string }) => a.id)
          const { invoiceMap, usageHistoryMap } = await prefetchInsightData(supabase, batchIds)

          // Evaluate rules for each account
          for (const account of batch as AccountRow[]) {
            // Same cooperative deadline check as the batch-loop entry above —
            // this per-account loop is where the sequential await time (one
            // syncInsights() DB round-trip per account) actually accumulates,
            // so a batch already in flight can itself cross the deadline.
            if (Date.now() - orgStartedAt > ORG_INSIGHTS_TIMEOUT_MS) {
              timedOut = true
              break
            }
            try {
              const invoiceData = invoiceMap.get(account.id)
              const usagePrevious = usageHistoryMap.get(account.id)
              const input = buildInsightInput(account, invoiceData, usagePrevious)

              // D1 (2026-08-02) : un compte churné n'est pas "à risque", il
              // est perdu — aucune règle ne doit produire de nouvel insight
              // (payment_risk sur une vieille facture, renewal_alert sur une
              // date de contrat obsolète, etc. peuvent sinon rester "vrais"
              // alors que le compte est déjà parti). candidates=[] déclenche
              // l'auto-résolution existante de syncInsights pour tout
              // insight resté actif sur ce compte.
              //
              // D-NEXT (2026-08-04, docs/openspec.md §5, CLAUDE.md) : ce
              // garde-fou lisait encore `account.mrr_cents === 0`, l'ancienne
              // définition D1 de "churné" — trouvée lors de l'auto-
              // vérification adversariale, jamais mise à jour quand D-NEXT a
              // découplé isChurned de mrr_cents===0. Un compte facturé
              // manuellement (invoice_only) ou entièrement metered a
              // mrr_status='unavailable' et mrr_cents=0 sans être churné —
              // c'est précisément le type de compte que D-NEXT visait à ne
              // plus geler par erreur, et qui a le plus besoin d'insights.
              // `churn_risk_band` est déjà réconcilié avec isAccountChurned()
              // par scoreAccountPure (calculate-scores/index.ts) — même
              // source que dashboard-api/get-today-status pour ce prédicat.
              const candidates = account.churn_risk_band === 'churned' ? [] : evaluateInsightRules(input)
              const { created, resolved } = await syncInsights(
                supabase,
                organizationId,
                account.id,
                candidates,
              )

              insightsCreated += created
              insightsResolved += resolved
              accountsEvaluated++
              logger.increment('records_processed')
            } catch (err) {
              console.error(JSON.stringify({
                level: 'error',
                function_name: 'generate-insights',
                organization_id: organizationId,
                account_id: account.id,
                message: err instanceof Error ? err.message : String(err),
              }))
              errors++
              logger.increment('records_failed')
            }
          }

          if (timedOut) break
          if (batch.length < BATCH_SIZE) break
          batchOffset += batch.length
        }

        if (timedOut) {
          errors++
          await logger.fail(`Timed out after ${ORG_INSIGHTS_TIMEOUT_MS}ms — per-org isolation (2026-08-23, mirrors P1/issue #65 for calculate-scores/sync-stripe), stopped before this org could block every org after it.`)
          console.error(JSON.stringify({
            level: 'error',
            function_name: 'generate-insights',
            organization_id: organizationId,
            message: `org timed out after ${ORG_INSIGHTS_TIMEOUT_MS}ms — marked failed, loop continues`,
          }))
        } else {
          await logger.complete({
            insights_created: insightsCreated,
            insights_resolved: insightsResolved,
            accounts_evaluated: accountsEvaluated,
            errors,
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        try { await logger.fail(msg) } catch { /* logger failure must not crash */ }
        errors++
      }

      results.push({
        organization_id: organizationId,
        insights_created: insightsCreated,
        insights_resolved: insightsResolved,
        accounts_evaluated: accountsEvaluated,
        errors,
        timed_out: timedOut,
      })

      try {
        await releaseCronLock(supabase, lockKey)
      } catch (err) {
        console.error(`[generate-insights] Failed to release lock for ${organizationId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const timedOutCount = results.filter((r) => r.timed_out).length
    return jsonResponse({
      success: true,
      organizations_processed: orgs.length,
      organizations_timed_out: timedOutCount, // never silent — mirrors calculate-scores (P1, 2026-08-13)
      results,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'generate-insights',
      message: msg,
    }))

    await alertSlack(
      `generate-insights failed: ${msg}`,
      { level: 'critical' },
    )

    return errorResponse(`Insight generation failed: ${msg}`, 500)
  }
}))
