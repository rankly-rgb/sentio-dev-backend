// ============================================================
// Edge Function : playbook-export
// GET /playbook-export?playbook_id={uuid}
// Export CSV des comptes éligibles d'un playbook (identifiant compte,
// montant à risque, message personnalisé via merge-tags) — Zero-PII.
// cf. specs/001-playbooks-export-csv/contracts/playbook-export-api.md
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { evaluateConditions, type AccountData } from '../_shared/playbook-engine.ts'
import { resolveMergeTags, generateExportCsv, type ExportCsvRow } from '../_shared/merge-tags.ts'

const MAX_EXPORT_ACCOUNTS = 2000
const NO_TEMPLATE_MESSAGE = 'No active template for this playbook category — contact your administrator.'
const MS_PER_DAY = 86400000

const ACCOUNT_FIELDS =
  'id, organization_id, stripe_customer_id, hubspot_company_id, display_name, health_score, ' +
  'churn_risk_score, expansion_score, product_usage_score, mrr_cents, arr_cents, plan_tier, ' +
  'seat_count, seat_limit, contract_start_date, contract_end_date, created_at'

// ── Entrypoint ──────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'GET') return errorResponse('Method not allowed', 405)

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
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-export', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const url = new URL(req.url)
  const playbookId = url.searchParams.get('playbook_id')
  if (!playbookId) return errorResponse('playbook_id query parameter required', 400)

  return handleExport(supabase, playbookId, auth.organizationId)
})

// ── Export ──────────────────────────────────────────────────

export async function handleExport(
  supabase: SupabaseClient,
  playbookId: string,
  authOrgId: string,
): Promise<Response> {
  const { data: playbook, error: playbookError } = await supabase
    .from('playbooks')
    .select('id, organization_id, segment_id, eligibility_criteria, template_category')
    .eq('id', playbookId)
    .eq('organization_id', authOrgId)
    .maybeSingle()

  if (playbookError || !playbook) return errorResponse('Playbook not found', 404)

  const eligible = await resolveEligibleAccounts(supabase, playbook, authOrgId)

  const rows: ExportCsvRow[] = []
  if (eligible.length > 0) {
    const activityMap = await fetchLastActivityDays(supabase, eligible.map((a) => a.id))
    const template = await resolveActiveTemplate(supabase, authOrgId, playbook.template_category as string | null)

    for (const account of eligible) {
      const accountRef = account.stripe_customer_id ?? account.id
      const message = template
        ? resolveMergeTags(template.body, {
            display_name: account.display_name,
            mrr_cents: account.mrr_cents,
            days_since_last_activity: activityMap.get(account.id) ?? null,
          })
        : NO_TEMPLATE_MESSAGE

      rows.push({
        account_ref: accountRef,
        mrr_at_risk_cents: account.mrr_cents,
        message,
      })
    }
  }

  const csv = generateExportCsv(rows)

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="playbook-export-${playbookId}.csv"`,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    },
  })
}

// ── Comptes éligibles ─────────────────────────────────────────

async function resolveEligibleAccounts(
  supabase: SupabaseClient,
  playbook: { segment_id: string | null; eligibility_criteria: unknown },
  orgId: string,
): Promise<AccountData[]> {
  let accountQuery = supabase
    .from('accounts')
    .select(ACCOUNT_FIELDS)
    .eq('organization_id', orgId)

  if (playbook.segment_id) {
    const { data: memberships } = await supabase
      .from('segment_memberships')
      .select('account_id')
      .eq('organization_id', orgId)
      .eq('segment_id', playbook.segment_id)
      .eq('status', 'active')
      .limit(MAX_EXPORT_ACCOUNTS)

    const ids = (memberships ?? []).map((m: { account_id: string }) => m.account_id)
    if (ids.length === 0) return []
    accountQuery = accountQuery.in('id', ids)
  } else {
    accountQuery = accountQuery.limit(MAX_EXPORT_ACCOUNTS)
  }

  const { data: accounts } = await accountQuery
  const rows = (accounts ?? []) as unknown as AccountData[]

  if (!playbook.eligibility_criteria) return rows

  return rows.filter((a) =>
    evaluateConditions(playbook.eligibility_criteria as Parameters<typeof evaluateConditions>[0], a as unknown as Record<string, unknown>),
  )
}

// ── Dernière activité par compte (batch, pas de N+1) ──────────

async function fetchLastActivityDays(
  supabase: SupabaseClient,
  accountIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (accountIds.length === 0) return result

  const { data: usageRows } = await supabase
    .from('usage_events')
    .select('account_id, event_date')
    .in('account_id', accountIds)
    .order('event_date', { ascending: false })

  const now = Date.now()
  for (const row of (usageRows ?? []) as { account_id: string; event_date: string }[]) {
    if (result.has(row.account_id)) continue // déjà la plus récente (tri desc)
    const eventDate = new Date(row.event_date).getTime()
    const days = Math.max(0, Math.floor((now - eventDate) / MS_PER_DAY))
    result.set(row.account_id, days)
  }
  return result
}

// ── Sélection du template actif ───────────────────────────────

async function resolveActiveTemplate(
  supabase: SupabaseClient,
  orgId: string,
  templateCategory: string | null,
): Promise<{ body: string } | null> {
  if (!templateCategory) return null

  const { data: templates } = await supabase
    .from('playbook_message_templates')
    .select('body, is_default, created_at')
    .eq('organization_id', orgId)
    .eq('template_category', templateCategory)
    .eq('is_active', true)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1)

  return (templates?.[0] as { body: string } | undefined) ?? null
}
