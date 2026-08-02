// ============================================================
// Edge Function : onboarding-first-win
// Retourne les données du "aha moment" : comptes les plus à
// risque, MRR exposé et score de santé global de l'org.
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// GET /onboarding-first-win
//   Auth : Bearer token (JWT Supabase)
//
//   Response 200 :
//     {
//       data: {
//         total_accounts: number,
//         at_risk_accounts: [          // top 3 health_score ASC, comptes churnés exclus (D1/C2.2)
//           {
//             stripe_customer_id: string,
//             display_name: string | null,
//             health_score: number,
//             churn_risk: number,
//             mrr: number,             // en centimes
//             top_risk_reason: string  // ex. "Overdue invoice for 20 day(s)"
//           }
//         ],
//         mrr_at_risk: number,         // somme MRR comptes health_score < 40, comptes churnés exclus
//         global_health_score: number  // moyenne arrondie, comptes churnés exclus
//       }
//     }
//
//   Response 404 : { error: 'No accounts found' }
//     (Stripe pas encore synchée)
//
// Auth : JWT utilisateur vérifié dans le code (ES256 via verifyUserAuth)
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'

interface AccountRow {
  id: string
  stripe_customer_id: string
  display_name: string | null
  health_score: number | null
  churn_risk_score: number | null
  churn_risk_band: string | null
  mrr_cents: number | null
  financial_score: number | null
}

interface InvoiceRow {
  account_id: string
  due_date: string | null
  status: string
}

interface UsageRow {
  account_id: string
  last_event_at: string
}

interface AtRiskAccount {
  stripe_customer_id: string
  display_name: string | null
  health_score: number
  churn_risk: number
  mrr: number
  top_risk_reason: string
}

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

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'onboarding-first-win', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const orgId = auth.organizationId

  // Récupérer tous les comptes avec scores — exclut les comptes churnés
  // (D1/C2.2 : un compte parti n'est pas "à risque", il est perdu ; sans ce
  // filtre, un compte churné avec un health_score bas — dimension jamais
  // gelée par D1 — pourrait apparaître dans le top 3 "at risk" du premier
  // écran vu par un nouvel utilisateur).
  const { data: accounts, error: accountsError } = await supabase
    .from('accounts')
    .select('id, stripe_customer_id, display_name, health_score, churn_risk_score, churn_risk_band, mrr_cents, financial_score')
    .eq('organization_id', orgId)
    .not('health_score', 'is', null)
    // .neq() exclurait aussi les lignes NULL (NULL != 'churned' est NULL, pas
    // TRUE, en SQL) — .or() explicite pour ne jamais filtrer un compte pas
    // encore scoré par accident.
    .or('churn_risk_band.neq.churned,churn_risk_band.is.null')
    .order('health_score', { ascending: true })
    .limit(500)

  if (accountsError) {
    console.error(JSON.stringify({ level: 'error', function_name: 'onboarding-first-win', message: accountsError.message }))
    return errorResponse('Failed to fetch accounts', 500)
  }

  if (!accounts || accounts.length === 0) {
    return errorResponse('No accounts found', 404)
  }

  const typedAccounts = accounts as AccountRow[]
  const top3 = typedAccounts.slice(0, 3)
  const top3Ids = top3.map((a) => a.id)

  // Récupérer les factures impayées pour les top 3 comptes en une seule query
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const { data: overdueInvoices } = await supabase
    .from('invoices')
    .select('account_id, due_date, status')
    .in('account_id', top3Ids)
    .in('status', ['open', 'uncollectible'])
    .lt('due_date', sevenDaysAgo)
    .order('due_date', { ascending: true })

  // Récupérer le dernier événement d'usage pour les top 3 comptes
  const { data: lastUsageRows } = await supabase
    .from('usage_events')
    .select('account_id, created_at')
    .in('account_id', top3Ids)
    .order('created_at', { ascending: false })

  // Construire une Map account_id → première facture impayée
  const overdueByAccount = new Map<string, InvoiceRow>()
  for (const inv of (overdueInvoices as InvoiceRow[] | null) ?? []) {
    if (!overdueByAccount.has(inv.account_id)) {
      overdueByAccount.set(inv.account_id, inv)
    }
  }

  // Construire une Map account_id → dernier événement d'usage
  const lastUsageByAccount = new Map<string, string>()
  for (const row of (lastUsageRows as (UsageRow & { created_at: string })[] | null) ?? []) {
    if (!lastUsageByAccount.has(row.account_id)) {
      lastUsageByAccount.set(row.account_id, row.created_at)
    }
  }

  const today = Date.now()

  const atRiskAccounts: AtRiskAccount[] = top3.map((account) => {
    return {
      stripe_customer_id: account.stripe_customer_id,
      display_name: account.display_name,
      health_score: account.health_score ?? 0,
      churn_risk: account.churn_risk_score ?? 0,
      mrr: account.mrr_cents ?? 0,
      top_risk_reason: buildRiskReason(account, overdueByAccount, lastUsageByAccount, today),
    }
  })

  // MRR à risque = somme des MRR des comptes avec health_score < 40
  const mrrAtRisk = typedAccounts
    .filter((a) => (a.health_score ?? 100) < 40)
    .reduce((sum, a) => sum + (a.mrr_cents ?? 0), 0)

  // Score de santé global = moyenne de tous les comptes scorés
  const totalHealth = typedAccounts.reduce((sum, a) => sum + (a.health_score ?? 0), 0)
  const globalHealthScore = Math.round(totalHealth / typedAccounts.length)

  return jsonResponse({
    data: {
      total_accounts: typedAccounts.length,
      at_risk_accounts: atRiskAccounts,
      mrr_at_risk: mrrAtRisk,
      global_health_score: globalHealthScore,
    },
  })
})

export function buildRiskReason(
  account: AccountRow,
  overdueByAccount: Map<string, InvoiceRow>,
  lastUsageByAccount: Map<string, string>,
  today: number,
): string {
  // 1. Facture impayée ?
  const overdueInvoice = overdueByAccount.get(account.id)
  if (overdueInvoice?.due_date) {
    const dueDaysAgo = Math.floor((today - new Date(overdueInvoice.due_date).getTime()) / (1000 * 60 * 60 * 24))
    if (dueDaysAgo > 0) {
      return `Overdue invoice for ${dueDaysAgo} day(s)`
    }
  }

  // 2. Aucune activité depuis 30+ jours ?
  const lastUsageAt = lastUsageByAccount.get(account.id)
  if (lastUsageAt) {
    const daysSinceUsage = Math.floor((today - new Date(lastUsageAt).getTime()) / (1000 * 60 * 60 * 24))
    if (daysSinceUsage >= 30) {
      return `No activity for ${daysSinceUsage} days`
    }
  } else {
    return 'No activity for over 30 days'
  }

  // 3. Santé financière dégradée ?
  if ((account.financial_score ?? 100) < 30) {
    return 'Degraded financial health'
  }

  return 'Low health score'
}
