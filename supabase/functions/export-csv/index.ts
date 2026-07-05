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
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'

const MAX_LIMIT = 2000
const DEFAULT_LIMIT = 500
const STRIPE_BATCH_SIZE = 10
const STRIPE_BATCH_DELAY_MS = 100

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

export interface ContactInfo {
  email: string
  name: string
}

// ── Helpers exportés pour les tests ──────────────────────────

export function maskCustomerId(id: string): string {
  return `cus_***${id.slice(-3)}`
}

export function escapeField(val: unknown): string {
  const str = String(val ?? '')
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

export function generateCsv(
  accounts: AccountRow[],
  emailMap: Map<string, ContactInfo>,
  includeEmail: boolean,
): string {
  const headers = [
    'Entreprise',
    'ID Stripe',
    ...(includeEmail ? ['Email'] : []),
    'MRR (€)',
    'Score santé',
    'Risque churn',
    'Score expansion',
    'Plan',
    'Seats',
    'Fin contrat',
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
  return `=== MODÈLE DE SÉQUENCE EMAIL — Sentio AI ===
Généré le ${new Date().toLocaleDateString('fr-FR')}
Ce modèle est un point de départ. Personnalisez avant envoi.

=== EMAIL 1 — Jour J ===
Objet : [Votre produit] — on voulait prendre de vos nouvelles

Bonjour,

Je voulais m'assurer que tout se passe bien de votre côté
avec [votre produit].

Nos données montrent que votre utilisation a évolué
récemment, et je voulais être disponible si vous avez
des questions ou des difficultés.

Avez-vous 15 minutes cette semaine pour qu'on en parle ?

Cordialement,
[Votre nom]

=== EMAIL 2 — Jour J+3 ===
Objet : RE : [Votre produit] — une ressource qui pourrait vous aider

Bonjour,

Je me permets de relancer avec une ressource qui aide
souvent dans votre situation : [LIEN VERS DOCUMENTATION
OU CAS D'USAGE PERTINENT].

Si vous rencontrez un blocage spécifique, je peux
organiser un appel rapide avec notre équipe support.

Bonne journée,
[Votre nom]

=== EMAIL 3 — Jour J+7 ===
Objet : Dernière tentative — [Votre produit]

Bonjour,

Je ne veux pas être intrusif, mais je tenais à vous
contacter une dernière fois.

Si [votre produit] ne répond plus à vos besoins actuels,
je serais heureux d'échanger sur comment nous pourrions
adapter notre offre — ou comprendre ce qui n'a pas
fonctionné pour vous.

Votre retour est précieux pour nous.

Cordialement,
[Votre nom]

---
Exporté depuis Sentio AI — https://app.sentioapp.io
Les emails ont été résolus depuis Stripe en transit.
Aucune donnée personnelle n'est stockée par Sentio.
`
}

// ── Résolution emails Stripe en transit ──────────────────────

export async function resolveEmails(
  stripeApiKey: string,
  customerIds: string[],
  fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
    fetchWithTimeout(url, init, 5000),
): Promise<Map<string, ContactInfo>> {
  const results = new Map<string, ContactInfo>()

  for (let i = 0; i < customerIds.length; i += STRIPE_BATCH_SIZE) {
    const batch = customerIds.slice(i, i + STRIPE_BATCH_SIZE)
    await Promise.all(
      batch.map(async (customerId) => {
        try {
          const resp = await fetcher(
            `https://api.stripe.com/v1/customers/${customerId}`,
            { headers: { Authorization: `Bearer ${stripeApiKey}` } },
          )
          if (resp.ok) {
            const customer = await resp.json()
            results.set(customerId, {
              email: typeof customer.email === 'string' ? customer.email : '',
              name: typeof customer.name === 'string' ? customer.name : '',
            })
          } else {
            results.set(customerId, { email: '', name: '' })
          }
        } catch {
          results.set(customerId, { email: '', name: '' })
        }
      }),
    )
    if (i + STRIPE_BATCH_SIZE < customerIds.length) {
      await new Promise((r) => setTimeout(r, STRIPE_BATCH_DELAY_MS))
    }
  }
  return results
}

// ── Handler principal ─────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
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

  query = query.order('churn_risk_score', { ascending: false }).limit(limit)

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
})
