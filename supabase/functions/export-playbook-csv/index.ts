// ============================================================
// Edge Function : export-playbook-csv
// Chantier A — Payment Recovery et autres playbooks : preview des
// comptes ciblés par un playbook, export CSV pour l'outil d'emailing
// externe du client, puis marquage "executed" une fois l'envoi
// confirmé côté client (anti-double-relance).
//
// Réutilise resolvePlaybookTargetAccounts (_shared/playbook-targeting.ts,
// même ciblage que playbook-execute) et resolveEmails (_shared/csv-export-utils.ts,
// même résolution email Stripe en transit que export-csv) — pas de
// duplication de la logique de ciblage ni de la logique Zero-PII.
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// POST /export-playbook-csv
//   Auth : Bearer token utilisateur (JWT ES256)
//   Body : {
//     playbook_id                    : string
//     preview?                       : boolean  // défaut false — true = JSON, pas de CSV, pas de run enregistré
//     include_email?                 : boolean  // défaut true (export réel uniquement)
//     exclude_executed_within_days?  : number   // défaut 30 — anti-double-relance
//   }
//   Response 200 (preview=true)  : JSON { data: { accounts_count, mrr_at_risk_cents, accounts: [...] } }
//   Response 200 (export réel)   : text/csv (téléchargement direct), enregistre un playbook_runs (status='exported')
//
// PATCH /export-playbook-csv
//   Auth : Bearer token utilisateur (JWT ES256)
//   Body : { run_id: string }
//   Response 200 : { success: true, updated: boolean }  -- marque le run 'executed' (idempotent)
//
// GET /export-playbook-csv?playbook_id=xxx
//   Auth : Bearer token utilisateur (JWT ES256)
//   Response 200 : { data: { runs: PlaybookRun[] } }  -- historique des runs (50 derniers, plus récent d'abord)
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { resolvePlaybookTargetAccounts, type TargetablePlaybook } from '../_shared/playbook-targeting.ts'
import { resolveEmails, escapeField, type ContactInfo } from '../_shared/csv-export-utils.ts'
import type { AccountData } from '../_shared/playbook-engine.ts'

const MAX_ACCOUNTS_PER_RUN = 200
const DEFAULT_EXCLUDE_EXECUTED_WITHIN_DAYS = 30

interface ExportRequestBody {
  playbook_id?: string
  preview?: boolean
  include_email?: boolean
  exclude_executed_within_days?: number
}

interface MarkExecutedBody {
  run_id?: string
}

interface InvoiceOverdueInfo {
  amount_cents: number
  days_overdue: number
}

// ── Helpers ───────────────────────────────────────────────────

export interface RawOverdueInvoice {
  account_id: string
  amount_cents: number
  due_date: string
}

// Exportée pour les tests — pure, pas d'accès DB. Suppose invoices déjà
// filtrées (status open/uncollectible, due_date < today) et triées par
// due_date ASC : la première ligne rencontrée par compte est la facture
// la plus ancienne (la plus en retard) — c'est celle-là qu'on retient.
export function pickOldestOverdueByAccount(
  invoices: RawOverdueInvoice[],
  now: number = Date.now(),
): Map<string, InvoiceOverdueInfo> {
  const result = new Map<string, InvoiceOverdueInfo>()
  for (const inv of invoices) {
    if (result.has(inv.account_id)) continue
    const daysOverdue = Math.floor((now - new Date(inv.due_date).getTime()) / 86400000)
    result.set(inv.account_id, { amount_cents: inv.amount_cents, days_overdue: daysOverdue })
  }
  return result
}

async function fetchOverdueInvoiceByAccount(
  supabase: SupabaseClient,
  organizationId: string,
  accountIds: string[],
): Promise<Map<string, InvoiceOverdueInfo>> {
  if (accountIds.length === 0) return new Map()

  const today = new Date().toISOString().slice(0, 10)
  const { data: invoices } = await supabase
    .from('invoices')
    .select('account_id, amount_cents, due_date')
    .eq('organization_id', organizationId)
    .in('account_id', accountIds)
    .in('status', ['open', 'uncollectible'])
    .lt('due_date', today)
    .order('due_date', { ascending: true })

  return pickOldestOverdueByAccount((invoices ?? []) as RawOverdueInvoice[])
}

// Exportée pour les tests — pure, pas d'accès DB.
export function filterOutExecutedAccountIds<T extends { id: string }>(
  accounts: T[],
  recentRuns: Array<{ account_ids: string[] | null }>,
): T[] {
  const excludedIds = new Set<string>()
  for (const run of recentRuns) {
    for (const id of run.account_ids ?? []) excludedIds.add(id)
  }
  if (excludedIds.size === 0) return accounts
  return accounts.filter((a) => !excludedIds.has(a.id))
}

async function excludeRecentlyExecuted(
  supabase: SupabaseClient,
  playbookId: string,
  accounts: AccountData[],
  withinDays: number,
): Promise<AccountData[]> {
  if (withinDays <= 0 || accounts.length === 0) return accounts

  const cutoff = new Date(Date.now() - withinDays * 86400000).toISOString()
  const { data: recentRuns } = await supabase
    .from('playbook_runs')
    .select('account_ids')
    .eq('playbook_id', playbookId)
    .eq('status', 'executed')
    .gte('executed_at', cutoff)

  return filterOutExecutedAccountIds(accounts, (recentRuns ?? []) as Array<{ account_ids: string[] | null }>)
}

function generatePlaybookCsv(
  accounts: AccountData[],
  emailMap: Map<string, ContactInfo>,
  overdueMap: Map<string, InvoiceOverdueInfo>,
): string {
  const headers = [
    'Company',
    'Email',
    'Stripe ID',
    'MRR (USD)',
    'Amount Due (USD)',
    'Days Overdue',
    'Health Score',
    'Churn Risk',
  ]

  const rows = accounts.map((a) => {
    const contact = emailMap.get(a.stripe_customer_id ?? '')
    const overdue = overdueMap.get(a.id)
    return [
      a.display_name ?? '',
      contact?.email ?? '',
      a.stripe_customer_id ?? '',
      ((a.mrr_cents ?? 0) / 100).toFixed(2),
      overdue ? (overdue.amount_cents / 100).toFixed(2) : '',
      overdue ? String(overdue.days_overdue) : '',
      a.health_score ?? '',
      a.churn_risk_score ?? '',
    ]
  })

  return [headers, ...rows].map((row) => row.map(escapeField).join(',')).join('\n')
}

// ── Handlers ────────────────────────────────────────────────

async function handlePatch(req: Request, supabase: SupabaseClient, organizationId: string): Promise<Response> {
  let body: MarkExecutedBody
  try {
    const text = await req.text()
    body = text ? JSON.parse(text) : {}
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!body.run_id) return errorResponse('run_id is required', 400)

  const { data, error } = await supabase.rpc('mark_playbook_executed', {
    p_run_id: body.run_id,
    p_organization_id: organizationId,
  })

  if (error) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'export-playbook-csv',
      organization_id: organizationId,
      message: `mark_playbook_executed RPC failed: ${error.message}`,
    }))
    return errorResponse('Failed to mark run as executed', 500)
  }

  const updated = Array.isArray(data) ? Boolean(data[0]?.updated) : false
  return jsonResponse({ success: true, updated })
}

async function handlePost(req: Request, supabase: SupabaseClient, organizationId: string): Promise<Response> {
  let body: ExportRequestBody
  try {
    const text = await req.text()
    body = text ? JSON.parse(text) : {}
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!body.playbook_id) return errorResponse('playbook_id is required', 400)

  const { data: playbook, error: pbError } = await supabase
    .from('playbooks')
    .select('id, title, segment_id, eligibility_criteria, organization_id')
    .eq('id', body.playbook_id)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (pbError || !playbook) return errorResponse('Playbook not found', 404)

  let targetAccounts = await resolvePlaybookTargetAccounts(
    supabase,
    playbook as TargetablePlaybook,
    organizationId,
    MAX_ACCOUNTS_PER_RUN,
  )

  const excludeDays = body.exclude_executed_within_days ?? DEFAULT_EXCLUDE_EXECUTED_WITHIN_DAYS
  targetAccounts = await excludeRecentlyExecuted(supabase, body.playbook_id, targetAccounts, excludeDays)

  const mrrAtRiskCents = targetAccounts.reduce((sum, a) => sum + (a.mrr_cents ?? 0), 0)

  if (body.preview) {
    return jsonResponse({
      data: {
        accounts_count: targetAccounts.length,
        mrr_at_risk_cents: mrrAtRiskCents,
        accounts: targetAccounts.map((a) => ({
          id: a.id,
          display_name: a.display_name,
          mrr_cents: a.mrr_cents,
          health_score: a.health_score,
          churn_risk_score: a.churn_risk_score,
        })),
      },
    })
  }

  const { data: org } = await supabase
    .from('organizations')
    .select('stripe_api_key')
    .eq('id', organizationId)
    .maybeSingle()
  const stripeApiKey: string = org?.stripe_api_key ?? Deno.env.get('STRIPE_SECRET_KEY') ?? ''

  const includeEmail = body.include_email !== false
  let emailMap = new Map<string, ContactInfo>()
  if (includeEmail && stripeApiKey && targetAccounts.length > 0) {
    const customerIds = targetAccounts
      .map((a) => a.stripe_customer_id)
      .filter((id): id is string => Boolean(id))
    emailMap = await resolveEmails(stripeApiKey, customerIds)
  }

  const overdueMap = await fetchOverdueInvoiceByAccount(
    supabase,
    organizationId,
    targetAccounts.map((a) => a.id),
  )

  const csvContent = generatePlaybookCsv(targetAccounts, emailMap, overdueMap)

  const { error: runError } = await supabase
    .from('playbook_runs')
    .insert({
      organization_id: organizationId,
      playbook_id: body.playbook_id,
      target_label: (playbook as { title?: string }).title ?? null,
      accounts_count: targetAccounts.length,
      mrr_at_risk_cents: mrrAtRiskCents,
      account_ids: targetAccounts.map((a) => a.id),
      status: 'exported',
    })

  if (runError) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'export-playbook-csv',
      organization_id: organizationId,
      message: `playbook_runs insert failed: ${runError.message}`,
    }))
  }

  console.log(JSON.stringify({
    level: 'info',
    function_name: 'export-playbook-csv',
    organization_id: organizationId,
    playbook_id: body.playbook_id,
    accounts_count: targetAccounts.length,
    mrr_at_risk_cents: mrrAtRiskCents,
    email_resolved: emailMap.size,
  }))

  return new Response(csvContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="sentio-playbook-export-${Date.now()}.csv"`,
      'X-Transit-PII': 'emails-resolved-from-stripe-not-stored',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    },
  })
}

async function handleGet(req: Request, supabase: SupabaseClient, organizationId: string): Promise<Response> {
  const url = new URL(req.url)
  const playbookId = url.searchParams.get('playbook_id')
  if (!playbookId) return errorResponse('playbook_id query param is required', 400)

  const { data: runs, error } = await supabase
    .from('playbook_runs')
    .select('id, target_label, accounts_count, mrr_at_risk_cents, status, exported_at, executed_at')
    .eq('organization_id', organizationId)
    .eq('playbook_id', playbookId)
    .order('exported_at', { ascending: false })
    .limit(50)

  if (error) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'export-playbook-csv',
      organization_id: organizationId,
      message: `playbook_runs list failed: ${error.message}`,
    }))
    return errorResponse('Failed to list runs', 500)
  }

  return jsonResponse({ data: { runs: runs ?? [] } })
}

// ── Entrypoint ──────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PATCH') {
    return errorResponse('Method not allowed', 405)
  }

  let auth
  try {
    auth = await verifyUserAuth(req)
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.message, err.status)
    return errorResponse('Authentication failed', 401)
  }

  let supabase: SupabaseClient
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'export-playbook-csv', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  if (req.method === 'GET') {
    return handleGet(req, supabase, auth.organizationId)
  }
  if (req.method === 'PATCH') {
    return handlePatch(req, supabase, auth.organizationId)
  }
  return handlePost(req, supabase, auth.organizationId)
})
