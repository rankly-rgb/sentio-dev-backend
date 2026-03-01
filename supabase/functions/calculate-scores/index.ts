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

// ── Types ────────────────────────────────────────────────────
interface Account {
  id: string
  organization_id: string
  mrr_cents: number | null
  seat_count: number | null
  seat_limit: number | null
  contract_end_date: string | null
  health_score: number | null
  churn_risk_score: number | null
}

interface UsageStats {
  login_count: number
  feature_count: number
  total_events: number
  distinct_features: number
  days_active: number
}

interface HubspotData {
  nps_score: number | null
  open_ticket_count: number | null
  open_deal_count: number | null
  last_meeting_date: string | null
}

interface InvoiceStatus {
  has_overdue: boolean
  overdue_count: number
}

// ── Calcul Usage Score (35%) ──────────────────────────────────
function calcUsageScore(stats: UsageStats): number {
  if (stats.total_events === 0) return 0

  // Activité sur les 30 derniers jours (max 30j)
  const activityScore = Math.min(100, (stats.days_active / 30) * 100)
  // Diversité des features utilisées (max 10 features = 100)
  const featureScore = Math.min(100, (stats.distinct_features / 10) * 100)
  // Volume d'utilisation (log scale, 1000 events = 100)
  const volumeScore = Math.min(100, (Math.log10(Math.max(1, stats.total_events)) / 3) * 100)

  return Math.round((activityScore * 0.4 + featureScore * 0.3 + volumeScore * 0.3) * 100) / 100
}

// ── Calcul Financial Score (25%) ──────────────────────────────
function calcFinancialScore(
  mrrCents: number | null,
  invoiceStatus: InvoiceStatus,
  maxMrr: number,
): number {
  if (!mrrCents || mrrCents <= 0) return 0

  // Score MRR relatif à l'org (top account = 100)
  const mrrScore = maxMrr > 0 ? Math.min(100, (mrrCents / maxMrr) * 100) : 50

  // Pénalité factures impayées
  const penaltyFactor = invoiceStatus.has_overdue
    ? Math.max(0, 1 - invoiceStatus.overdue_count * 0.2)
    : 1

  return Math.round(mrrScore * penaltyFactor * 100) / 100
}

// ── Calcul Engagement Score (20%) ─────────────────────────────
function calcEngagementScore(hubspot: HubspotData | null): number {
  if (!hubspot) return 50 // score neutre si pas de données HubSpot

  let score = 50 // base

  // NPS
  if (hubspot.nps_score !== null) {
    if (hubspot.nps_score >= 9) score += 30
    else if (hubspot.nps_score >= 7) score += 15
    else if (hubspot.nps_score >= 5) score += 0
    else score -= 20
  }

  // Tickets ouverts (indicateur de friction)
  if (hubspot.open_ticket_count !== null) {
    if (hubspot.open_ticket_count === 0) score += 10
    else if (hubspot.open_ticket_count >= 3) score -= 15
  }

  // Dernière réunion < 60 jours
  if (hubspot.last_meeting_date) {
    const daysSince = Math.floor(
      (Date.now() - new Date(hubspot.last_meeting_date).getTime()) / 86400000,
    )
    if (daysSince < 30) score += 10
    else if (daysSince > 90) score -= 10
  }

  return Math.round(Math.max(0, Math.min(100, score)) * 100) / 100
}

// ── Calcul Contract Score (20%) ───────────────────────────────
function calcContractScore(account: Account): number {
  if (!account.contract_end_date) return 50 // neutre si pas de date

  const daysUntilRenewal = Math.floor(
    (new Date(account.contract_end_date).getTime() - Date.now()) / 86400000,
  )

  if (daysUntilRenewal < 0) return 10 // contrat expiré
  if (daysUntilRenewal <= 30) return 25
  if (daysUntilRenewal <= 60) return 50
  if (daysUntilRenewal <= 90) return 75
  return 100
}

// ── Calcul Expansion Score ────────────────────────────────────
function calcExpansionScore(account: Account, stats: UsageStats): number {
  // seat_usage_pct × 60%
  let seatUsagePct = 50 // neutre
  if (account.seat_count !== null && account.seat_limit !== null && account.seat_limit > 0) {
    seatUsagePct = Math.min(100, (account.seat_count / account.seat_limit) * 100)
  }

  // feature_ceiling × 40% (proxy : diversité des features utilisées)
  const featureCeilingScore = Math.min(100, (stats.distinct_features / 10) * 100)

  return Math.round(
    (seatUsagePct * 0.6 + featureCeilingScore * 0.4) * 100,
  ) / 100
}

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

  const supabase = createServiceClient()

  let body: { organization_id?: string; snapshot_date?: string } = {}
  try {
    body = await req.json()
  } catch {
    // Body optionnel
  }

  const snapshotDate = body.snapshot_date ?? new Date().toISOString().split('T')[0]

  // Résoudre les organisations à traiter
  const orgQuery = supabase
    .from('organizations')
    .select('id')
    .eq('is_active', true)

  if (body.organization_id) {
    orgQuery.eq('id', body.organization_id)
  }

  const { data: orgs, error: orgError } = await orgQuery
  if (orgError || !orgs?.length) {
    return errorResponse('No active organizations found', 404)
  }

  const results: Array<{ organization_id: string; accounts_scored: number; errors: number }> = []

  for (const org of orgs) {
    const organizationId = org.id
    let accountsScored = 0
    let errors = 0

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

    if (!accounts?.length) continue

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
      } catch (err) {
        console.error(`[calculate-scores] error for account ${account.id}:`, err)
        errors++
      }
    }

    results.push({ organization_id: organizationId, accounts_scored: accountsScored, errors })
  }

  return jsonResponse({
    success: true,
    snapshot_date: snapshotDate,
    organizations_processed: orgs.length,
    results,
  })
})
