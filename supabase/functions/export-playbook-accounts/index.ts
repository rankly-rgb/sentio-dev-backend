// ============================================================
// Edge Function: export-playbook-accounts
// Exporte les comptes d'un playbook en CSV ou JSON avec priorite,
// trigger_reason, suggested_action et hubspot_import_note.
// ============================================================
//
// POST /functions/v1/export-playbook-accounts
// Headers: Authorization: Bearer <supabase_jwt>
// Content-Type: application/json
//
// Body:
// {
//   playbook_id: string,
//   format: 'csv' | 'json',
//   filters?: {
//     priority?: 'P0' | 'P1' | 'P2',
//     segment?: string,
//     churn_risk_min?: number,
//     mrr_min_cents?: number,
//     billing_interval?: 'monthly' | 'annual'
//   }
// }
//
// Reponse CSV : Content-Type: text/csv
//              Content-Disposition: attachment; filename="sentio-[playbook-slug]-[YYYY-MM-DD].csv"
// Reponse JSON: Content-Type: application/json
//               { accounts: Account[], meta: ExportMeta }
//
// Erreurs :
//   400 Bad Request  — playbook_id manquant ou format invalide
//   403 Forbidden    — organization_id ne correspond pas
//   500 Internal     — erreur serveur (sans stack trace)

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors, corsHeaders } from '../_shared/cors.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { createServiceClient, jsonResponse, errorResponse } from '../_shared/supabase-client.ts'
import { createLogger } from '../_shared/structured-logger.ts'
import { alertSlack } from '../_shared/slack-alert.ts'
import {
  type AccountRow,
  computePriority,
  computeDaysToRenewal,
  buildTriggerReason,
  buildHubspotImportNote,
  sortAccounts,
  buildCsv,
  formatActionType,
  CSV_COLUMNS,
} from '../_shared/export-helpers.ts'
import { withSentry } from '../_shared/sentry.ts'

// ============================================================
// Types
// ============================================================

interface ExportFilters {
  priority?: 'P0' | 'P1' | 'P2'
  segment?: string
  churn_risk_min?: number
  mrr_min_cents?: number
  billing_interval?: 'monthly' | 'annual'
}

interface ExportRequestBody {
  playbook_id: string
  format: 'csv' | 'json'
  filters?: ExportFilters
}

interface ExportMeta {
  playbook_id: string
  playbook_title: string
  exported_at: string
  account_count: number
  mrr_at_risk_cents: number
  by_priority: { P0: number; P1: number; P2: number }
  filters_applied: ExportFilters
}

// ============================================================
// Main handler
// ============================================================

Deno.serve(withSentry('export-playbook-accounts', async (req: Request): Promise<Response> => {
  // 1. CORS
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  // Only POST allowed
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  const correlationId = crypto.randomUUID()
  const logger = createLogger({
    correlation_id: correlationId,
    function_name: 'export-playbook-accounts',
  })

  // 2. AUTH
  let auth
  try {
    auth = await verifyUserAuth(req)
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.message, err.status)
    return errorResponse('Authentication failed', 401)
  }

  const orgId = auth.organizationId
  logger.info('Export request received', { organization_id: orgId })

  // 3. SERVICE CLIENT
  let supabase: SupabaseClient
  try {
    supabase = createServiceClient()
  } catch {
    logger.error('Service client creation failed')
    return errorResponse('Server configuration error', 500)
  }

  // 4. PARSE & VALIDATE BODY
  let body: ExportRequestBody
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!body.playbook_id) {
    return errorResponse('playbook_id is required', 400)
  }
  if (body.format && !['csv', 'json'].includes(body.format)) {
    return errorResponse('format must be csv or json', 400)
  }

  const format = body.format || 'csv'
  const filters: ExportFilters = body.filters ?? {}

  // 5. VERIFY PLAYBOOK OWNERSHIP
  const { data: playbook, error: playbookError } = await supabase
    .from('playbooks')
    .select('id, title, organization_id, actions')
    .eq('id', body.playbook_id)
    .eq('organization_id', orgId)
    .maybeSingle()

  if (playbookError) {
    logger.error('Playbook query failed', { error: playbookError.message })
    return errorResponse('Server error', 500)
  }
  if (!playbook) {
    return errorResponse('Playbook not found or access denied', 403)
  }

  // 6. QUERY ACCOUNTS with joins
  let accountsQuery = supabase
    .from('accounts')
    .select(`
      id,
      stripe_customer_id,
      hubspot_company_id,
      plan_tier,
      mrr_cents,
      health_score,
      churn_risk_score,
      expansion_score,
      billing_interval,
      contract_end_date,
      created_at
    `)
    .eq('organization_id', orgId)
    .limit(10000)

  // Apply DB-level filters
  if (filters.churn_risk_min !== undefined) {
    accountsQuery = accountsQuery.gte('churn_risk_score', filters.churn_risk_min)
  }
  if (filters.mrr_min_cents !== undefined) {
    accountsQuery = accountsQuery.gte('mrr_cents', filters.mrr_min_cents)
  }
  if (filters.billing_interval) {
    accountsQuery = accountsQuery.eq('billing_interval', filters.billing_interval)
  }

  const { data: rawAccounts, error: accountsError } = await accountsQuery

  if (accountsError) {
    logger.error('Accounts query failed', { error: accountsError.message })
    return errorResponse('Server error', 500)
  }

  if (!rawAccounts || rawAccounts.length === 0) {
    logger.info('No accounts found for export')
    if (format === 'json') {
      return jsonResponse({
        accounts: [],
        meta: {
          playbook_id: body.playbook_id,
          playbook_title: playbook.title,
          exported_at: new Date().toISOString(),
          account_count: 0,
          mrr_at_risk_cents: 0,
          by_priority: { P0: 0, P1: 0, P2: 0 },
          filters_applied: filters,
        },
      })
    }
    return new Response(CSV_COLUMNS.join(',') + '\n', {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="sentio-export-${new Date().toISOString().slice(0, 10)}.csv"`,
        ...corsHeaders,
      },
    })
  }

  const accountIds = rawAccounts.map((a: { id: string }) => a.id)

  // Fetch HubSpot data, unpaid invoices, last login, and segment memberships in parallel
  const [hubspotResult, invoicesResult, lastLoginResult, segmentsResult] = await Promise.all([
    supabase
      .from('hubspot_companies')
      .select('account_id, open_ticket_count, nps_score')
      .eq('organization_id', orgId)
      .in('account_id', accountIds)
      .limit(10000),
    supabase
      .from('invoices')
      .select('account_id, due_date, status')
      .eq('organization_id', orgId)
      .in('account_id', accountIds)
      .in('status', ['open', 'uncollectible'])
      .limit(10000),
    supabase
      .from('usage_events')
      .select('account_id, event_date')
      .eq('organization_id', orgId)
      .eq('event_type', 'login')
      .in('account_id', accountIds)
      .order('event_date', { ascending: false })
      .limit(10000),
    supabase
      .from('segment_memberships')
      .select('account_id, segment_id')
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .in('account_id', accountIds)
      .limit(10000),
  ])

  // Build lookup maps
  const hubspotMap = new Map<string, { open_ticket_count: number | null; nps_score: number | null }>()
  for (const h of hubspotResult.data ?? []) {
    hubspotMap.set(h.account_id, { open_ticket_count: h.open_ticket_count, nps_score: h.nps_score })
  }

  const unpaidInvoiceMap = new Map<string, number>()
  const now = new Date()
  for (const inv of invoicesResult.data ?? []) {
    if (inv.due_date) {
      const dueDate = new Date(inv.due_date)
      const daysOverdue = Math.ceil((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
      const existing = unpaidInvoiceMap.get(inv.account_id)
      if (existing === undefined || daysOverdue > existing) {
        unpaidInvoiceMap.set(inv.account_id, Math.max(0, daysOverdue))
      }
    }
  }

  const lastLoginMap = new Map<string, number>()
  for (const evt of lastLoginResult.data ?? []) {
    if (!lastLoginMap.has(evt.account_id) && evt.event_date) {
      const loginDate = new Date(evt.event_date)
      const daysAgo = Math.ceil((now.getTime() - loginDate.getTime()) / (1000 * 60 * 60 * 24))
      lastLoginMap.set(evt.account_id, Math.max(0, daysAgo))
    }
  }

  // Fetch segment names
  const segmentIds = Array.from(new Set((segmentsResult.data ?? []).map((s: { segment_id: string }) => s.segment_id)))
  const segmentNameMap = new Map<string, string>()
  if (segmentIds.length > 0) {
    const { data: segments } = await supabase
      .from('account_segments')
      .select('id, segment_name')
      .eq('organization_id', orgId)
      .in('id', segmentIds)
      .limit(100)

    for (const s of segments ?? []) {
      segmentNameMap.set(s.id, s.segment_name)
    }
  }

  const accountSegmentMap = new Map<string, string>()
  for (const sm of segmentsResult.data ?? []) {
    const name = segmentNameMap.get(sm.segment_id)
    if (name) accountSegmentMap.set(sm.account_id, name)
  }

  // Derive suggested_action from first playbook action
  const playbookActions = Array.isArray(playbook.actions) ? playbook.actions : []
  const firstAction = playbookActions.length > 0 ? playbookActions[0] : null
  const defaultSuggestedAction = firstAction
    ? formatActionType(firstAction.type, firstAction.config)
    : 'Manual review recommended'

  // 7. BUILD ACCOUNT ROWS
  const accountRows: AccountRow[] = []

  for (const acc of rawAccounts) {
    const daysToRenewal = computeDaysToRenewal(acc.contract_end_date, acc.billing_interval)
    const priority = computePriority(acc.churn_risk_score, daysToRenewal)
    const hubspot = hubspotMap.get(acc.id)
    const unpaidDays = unpaidInvoiceMap.get(acc.id) ?? null
    const lastLoginDaysAgo = lastLoginMap.get(acc.id) ?? null
    const segment = accountSegmentMap.get(acc.id) ?? null

    const triggerReason = buildTriggerReason({
      hasUnpaidInvoice: unpaidDays !== null,
      unpaidDays,
      loginDecline: false,
      lastLoginDaysAgo,
      daysToRenewal,
      churnRisk: acc.churn_risk_score,
      healthScore: acc.health_score,
    })

    const hubspotNote = buildHubspotImportNote(
      acc.health_score,
      acc.churn_risk_score,
      priority,
      defaultSuggestedAction
    )

    accountRows.push({
      stripe_customer_id: acc.stripe_customer_id,
      hubspot_company_id: acc.hubspot_company_id,
      plan_tier: acc.plan_tier,
      mrr_usd: acc.mrr_cents / 100,
      health_score: acc.health_score !== null ? Number(acc.health_score) : null,
      churn_risk_score: acc.churn_risk_score !== null ? Number(acc.churn_risk_score) : null,
      expansion_score: acc.expansion_score !== null ? Number(acc.expansion_score) : null,
      segment,
      days_to_renewal: daysToRenewal,
      billing_interval: acc.billing_interval,
      trigger_reason: triggerReason,
      suggested_playbook: playbook.title,
      suggested_action: defaultSuggestedAction,
      priority,
      last_login_days_ago: lastLoginDaysAgo,
      open_ticket_count: hubspot?.open_ticket_count ?? null,
      nps_score: hubspot?.nps_score ?? null,
      hubspot_import_note: hubspotNote,
    })
  }

  // Apply priority filter (post-computation, since priority is derived)
  let filteredRows = accountRows
  if (filters.priority) {
    filteredRows = accountRows.filter((r) => r.priority === filters.priority)
  }
  // Apply segment filter
  if (filters.segment) {
    filteredRows = filteredRows.filter((r) => r.segment === filters.segment)
  }

  // 8. SORT — P0 first, then P1, then P2. Within same priority, MRR descending.
  const sortedRows = sortAccounts(filteredRows)

  // 9. COMPUTE META
  const byPriority = { P0: 0, P1: 0, P2: 0 }
  let mrrAtRiskCents = 0
  for (const row of sortedRows) {
    byPriority[row.priority]++
    if (row.priority === 'P0' || row.priority === 'P1') {
      mrrAtRiskCents += Math.round(row.mrr_usd * 100)
    }
  }

  // 10. LOG EXPORT (idempotent via unique index — ON CONFLICT DO NOTHING)
  const { error: logError } = await supabase
    .from('playbook_exports')
    .insert({
      organization_id: orgId,
      playbook_id: body.playbook_id,
      exported_by_profile_id: auth.userId,
      account_count: sortedRows.length,
      mrr_at_risk_cents: mrrAtRiskCents,
      filters_applied: filters,
      format,
    })

  if (logError) {
    // Idempotency: unique index violation is expected for duplicate exports
    if (logError.code !== '23505') {
      logger.warn('Failed to log export', { error: logError.message })
    }
  }

  // 11. SLACK NOTIFICATION (fire-and-forget)
  const slackMessage = [
    `Playbook export — ${playbook.title}`,
    `${sortedRows.length} accounts exported · MRR at risk: $${Math.round(mrrAtRiskCents / 100)}`,
    `Priorities: ${byPriority.P0} P0 · ${byPriority.P1} P1 · ${byPriority.P2} P2`,
    `Triggered by: ${auth.userId}`,
  ].join('\n')

  // Fire-and-forget — never block response on Slack
  alertSlack(slackMessage, { level: byPriority.P0 > 0 ? 'warning' : 'info' }).catch(() => {})

  logger.info('Export completed', {
    organization_id: orgId,
    account_count: sortedRows.length,
    mrr_at_risk_cents: mrrAtRiskCents,
    format,
  })

  // 12. RESPONSE
  if (format === 'json') {
    const meta: ExportMeta = {
      playbook_id: body.playbook_id,
      playbook_title: playbook.title,
      exported_at: new Date().toISOString(),
      account_count: sortedRows.length,
      mrr_at_risk_cents: mrrAtRiskCents,
      by_priority: byPriority,
      filters_applied: filters,
    }
    return jsonResponse({ accounts: sortedRows, meta })
  }

  // CSV response
  const csv = buildCsv(sortedRows)
  const slug = playbook.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  const date = new Date().toISOString().slice(0, 10)

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="sentio-${slug}-${date}.csv"`,
      ...corsHeaders,
    },
  })
}))
