// ============================================================
// Edge Function : export-csv
// Export des comptes avec résolution email en transit depuis Stripe.
// Les emails ne sont JAMAIS persistés — résolus en mémoire uniquement.
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// POST /export-csv
//   Auth : Bearer token utilisateur (JWT ES256)
//   Body : {
//     segment_id?    : string   // filtre sur un segment
//     filters?       : { min_churn_risk?, min_mrr_cents?, max_health_score? }
//     include_email? : boolean  // défaut true
//     limit?         : number   // défaut 500, max 2000
//   }
//   Response 200 : text/csv (téléchargement direct)
//
// GET /export-csv?format=sequence_template[&segment_id=xxx]
//   Auth : Bearer token utilisateur (JWT ES256)
//   Response 200 : text/plain — 3 templates email pré-rédigés
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import {
  type ContactInfo,
  maskCustomerId,
  escapeField,
  resolveEmails,
} from '../_shared/csv-export-utils.ts'
import { withSentry } from '../_shared/sentry.ts'

const MAX_LIMIT = 2000
const DEFAULT_LIMIT = 500

export interface AccountRow {
  id: string
  stripe_customer_id: string
  display_name: string | null
  mrr_cents: number | null
  health_score: number | null
  churn_risk_score: number | null
  expansion_score: number | null
  plan_tier: string | null
  seat_count: number | null
  contract_end_date: string | null
}

export type { ContactInfo }
export { maskCustomerId, escapeField, resolveEmails }

export function generateCsv(
  accounts: AccountRow[],
  emailMap: Map<string, ContactInfo>,
  includeEmail: boolean,
): string {
  const headers = [
    'Company',
    'Stripe ID',
    ...(includeEmail ? ['Email'] : []),
    'MRR ($)',
    'Health Score',
    'Churn Risk',
    'Expansion Score',
    'Plan',
    'Seats',
    'Contract End',
  ]

  const rows = accounts.map((account) => {
    const contact = emailMap.get(account.stripe_customer_id ?? '')
    const displayName = account.display_name
      ?? contact?.name
      ?? maskCustomerId(account.stripe_customer_id ?? '')

    return [
      displayName,
      account.stripe_customer_id ?? '',
      ...(includeEmail ? [contact?.email ?? ''] : []),
      ((account.mrr_cents ?? 0) / 100).toFixed(2),
      account.health_score ?? '',
      account.churn_risk_score ?? '',
      account.expansion_score ?? '',
      account.plan_tier ?? '',
      account.seat_count ?? '',
      account.contract_end_date ?? '',
    ]
  })

  return [headers, ...rows]
    .map((row) => row.map(escapeField).join(','))
    .join('\n')
}

export function buildSequenceTemplate(): string {
  return `=== EMAIL SEQUENCE TEMPLATE — Sentio AI ===
Generated on ${new Date().toLocaleDateString('en-US')}
This template is a starting point. Customize it before sending.

=== EMAIL 1 — Day 0 ===
Subject: [Your product] — checking in

Hi there,

I wanted to make sure everything is going well on your end
with [your product].

Our data shows your usage has shifted recently, and I wanted
to be available if you have any questions or run into
any issues.

Do you have 15 minutes this week to chat?

Best,
[Your name]

=== EMAIL 2 — Day 3 ===
Subject: RE: [Your product] — a resource that might help

Hi there,

Following up with a resource that often helps in your
situation: [LINK TO RELEVANT DOCUMENTATION OR USE CASE].

If you're running into a specific blocker, I can set up
a quick call with our support team.

Have a great day,
[Your name]

=== EMAIL 3 — Day 7 ===
Subject: Last attempt — [Your product]

Hi there,

I don't want to be intrusive, but I wanted to reach out
one last time.

If [your product] no longer fits your current needs, I'd be
happy to discuss how we could adjust our offering — or
understand what didn't work for you.

Your feedback matters to us.

Best,
[Your name]

---
Exported from Sentio AI — https://app.sentioapp.io
Emails were resolved from Stripe in transit.
No personal data is stored by Sentio.
`
}

// ── Handler principal ─────────────────────────────────────────

Deno.serve(withSentry('export-csv', async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  const url = new URL(req.url)
  const format = url.searchParams.get('format')

  // ── Auth : user JWT ou service_role bypass ────────────────
  // verifyUserAuth lit uniquement les headers (pas le body) → safe de l'appeler avant
  // le parsing du body. Le bypass service_role permet les tests internes et les appels
  // depuis d'autres Edge Functions.
  const rawToken = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')

  // Détecte service_role en décodant le payload JWT (évite toute comparaison de chaîne fragile)
  function isServiceRoleJwt(token: string): boolean {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]))
      return payload.role === 'service_role'
    } catch {
      return false
    }
  }
  const isServiceRole = isServiceRoleJwt(rawToken)

  let orgIdFromAuth = ''
  if (!isServiceRole) {
    try {
      const auth = await verifyUserAuth(req)
      orgIdFromAuth = auth.organizationId
    } catch (err) {
      if (err instanceof AuthError) return errorResponse(err.message, err.status)
      return errorResponse('Authentication failed', 401)
    }
  }

  // ── GET ?format=sequence_template ────────────────────────
  if (req.method === 'GET' && format === 'sequence_template') {
    return new Response(buildSequenceTemplate(), {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="sentio-sequence-${Date.now()}.txt"`,
        'Access-Control-Allow-Origin': '*',
      },
    })
  }

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  // ── Parse body ────────────────────────────────────────────
  let body: {
    organization_id?: string
    segment_id?: string
    filters?: { min_churn_risk?: number; min_mrr_cents?: number; max_health_score?: number }
    include_email?: boolean
    limit?: number
  } = {}
  try {
    const text = await req.text()
    if (text) body = JSON.parse(text)
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  // ── Résolution orgId ──────────────────────────────────────
  let orgId: string
  if (isServiceRole) {
    if (body.organization_id) {
      orgId = body.organization_id
    } else {
      // Fallback : première org en base (tests sans org_id)
      let supabaseAdmin
      try { supabaseAdmin = createServiceClient() } catch { return errorResponse('Server configuration error', 500) }
      const { data: firstOrg } = await supabaseAdmin
        .from('organizations').select('id').limit(1).maybeSingle()
      if (!firstOrg?.id) return errorResponse('No organization found', 403)
      orgId = firstOrg.id
    }
  } else {
    orgId = orgIdFromAuth
  }

  const includeEmail = body.include_email !== false
  const limit = Math.min(body.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const filters = body.filters ?? {}

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'export-csv', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  // ── Récupérer clé Stripe de l'org ────────────────────────
  const { data: org } = await supabase
    .from('organizations')
    .select('stripe_api_key')
    .eq('id', orgId)
    .maybeSingle()

  const stripeApiKey: string = org?.stripe_api_key ?? Deno.env.get('STRIPE_SECRET_KEY') ?? ''

  // ── Résoudre les account_ids si segment_id fourni ────────
  let accountIdFilter: string[] | null = null
  if (body.segment_id) {
    const { data: memberships } = await supabase
      .from('segment_memberships')
      .select('account_id')
      .eq('organization_id', orgId)
      .eq('segment_id', body.segment_id)
      .eq('status', 'active')
      .limit(MAX_LIMIT)

    accountIdFilter = (memberships ?? []).map((m: { account_id: string }) => m.account_id)
    if (accountIdFilter.length === 0) {
      return new Response('Entreprise,ID Stripe\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="sentio-export-${Date.now()}.csv"`,
          'X-Transit-PII': 'emails-resolved-from-stripe-not-stored',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }
  }

  // ── Requête comptes ───────────────────────────────────────
  let query = supabase
    .from('accounts')
    .select('id, stripe_customer_id, display_name, mrr_cents, health_score, churn_risk_score, expansion_score, plan_tier, seat_count, contract_end_date')
    .eq('organization_id', orgId)

  if (accountIdFilter) query = query.in('id', accountIdFilter)
  if (filters.min_churn_risk !== undefined) query = query.gte('churn_risk_score', filters.min_churn_risk)
  if (filters.min_mrr_cents !== undefined) query = query.gte('mrr_cents', filters.min_mrr_cents)
  if (filters.max_health_score !== undefined) query = query.lte('health_score', filters.max_health_score)

  // nullsFirst: false — churned accounts (D1: churn_risk_score frozen to null)
  // must not sort as if they were the top risk just because NULL defaults
  // to NULLS FIRST on DESC order in Postgres.
  query = query.order('churn_risk_score', { ascending: false, nullsFirst: false }).limit(limit)

  const { data: accounts, error: acctError } = await query

  if (acctError) {
    console.error(JSON.stringify({ level: 'error', function_name: 'export-csv', org_id: orgId, message: acctError.message }))
    return errorResponse('Failed to fetch accounts', 500)
  }

  const rows = (accounts ?? []) as AccountRow[]

  // ── Résolution emails en transit ─────────────────────────
  let emailMap = new Map<string, ContactInfo>()
  if (includeEmail && stripeApiKey && rows.length > 0) {
    const customerIds = rows
      .map((a) => a.stripe_customer_id)
      .filter((id): id is string => Boolean(id))
    emailMap = await resolveEmails(stripeApiKey, customerIds)
  }

  // ── Génération CSV ────────────────────────────────────────
  const csvContent = generateCsv(rows, emailMap, includeEmail && Boolean(stripeApiKey))

  console.log(JSON.stringify({
    level: 'info',
    function_name: 'export-csv',
    org_id: orgId,
    rows: rows.length,
    include_email: includeEmail,
    has_stripe_key: Boolean(stripeApiKey),
    email_resolved: emailMap.size,
    csv_length: csvContent.length,
    csv_preview: csvContent.slice(0, 150),
  }))

  // Mode debug : retourne JSON au lieu de CSV pour diagnostiquer
  if (url.searchParams.get('debug') === 'true') {
    return new Response(JSON.stringify({
      org_id: orgId,
      accounts_count: rows.length,
      has_stripe_key: Boolean(stripeApiKey),
      csv_length: csvContent.length,
      csv_preview: csvContent.slice(0, 500),
      acct_error: acctError,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  }

  return new Response(csvContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="sentio-export-${Date.now()}.csv"`,
      'X-Transit-PII': 'emails-resolved-from-stripe-not-stored',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    },
  })
}))
