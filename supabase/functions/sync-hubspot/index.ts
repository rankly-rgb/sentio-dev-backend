// ============================================================
// Edge Function : sync-hubspot
// Synchronise les données HubSpot (companies) vers hubspot_companies.
// Alimente l'engagement_score (tickets, meetings) pour calculate-scores.
//
// Trigger : POST cron quotidien OU fire-and-forget depuis hubspot-connect
// Pattern : cron lock → DataSyncLogger → paginate HubSpot → upsert DB
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { acquireCronLock, releaseCronLock } from '../_shared/cron-lock.ts'
import { DataSyncLogger } from '../_shared/data-sync-logger.ts'
import { alertSlack } from '../_shared/slack-alert.ts'
import { createLogger } from '../_shared/structured-logger.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'
import { retryWithBackoff } from '../_shared/retry-with-backoff.ts'
import { hubspotRateLimiter } from '../_shared/hubspot-client.ts'
import {
  mapHubSpotProperties,
  buildStripeIdMap,
  buildHubspotIdMap,
  matchCompanyToAccount,
  computeReversePushList,
  batchArray,
  type HubSpotCompanyProperties,
} from '../_shared/hubspot-sync-helpers.ts'
import { getVaultSecret, resolveHubSpotApiKey } from '../_shared/vault.ts'

const HUBSPOT_BASE_URL = 'https://api.hubapi.com'
const PAGE_SIZE = 100
const MAX_PAGES = 10   // 1 000 companies max par run
const LOCK_KEY = 'sync-hubspot'
const LOCK_TTL_SECONDS = 300
const DB_BATCH_SIZE = 500

const HUBSPOT_PROPERTIES = [
  'lifecyclestage',
  'num_open_deals',
  'hs_ticket_count',
  'hs_last_meeting_booked',
  'notes_last_contacted',
  'id_stripe',   // propriété custom Sentio pour l'auto-matching stripe_customer_id
].join(',')

// ── Types ────────────────────────────────────────────────────

interface SyncHubSpotBody {
  organization_id?: string
  sync_type?: 'incremental' | 'full_sync'
  triggered_by?: string
  is_manual?: boolean
}

interface HubSpotCompany {
  id: string
  properties: HubSpotCompanyProperties
}

// ── HubSpot API ──────────────────────────────────────────────

function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message
  return msg.includes('timed out') || msg.includes('429') || msg.includes('503') || msg.includes('502')
}

async function fetchCompaniesPage(
  apiKey: string,
  after?: string,
): Promise<{ results: HubSpotCompany[]; nextAfter?: string }> {
  const url = new URL(`${HUBSPOT_BASE_URL}/crm/v3/objects/companies`)
  url.searchParams.set('properties', HUBSPOT_PROPERTIES)
  url.searchParams.set('limit', String(PAGE_SIZE))
  if (after) url.searchParams.set('after', after)

  const response = await retryWithBackoff(
    async () => {
      await hubspotRateLimiter.waitForToken()
      const res = await fetchWithTimeout(
        url.toString(),
        { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } },
        10000,
      )
      if (res.status === 429) throw new Error('HubSpot rate limit (429)')
      return res
    },
    { maxRetries: 2, retryOn: isTransient },
  )

  if (!response.ok) throw new Error(`HubSpot companies API HTTP ${response.status}`)

  const data = await response.json() as {
    results: HubSpotCompany[]
    paging?: { next?: { after: string } }
  }
  return {
    results: data.results ?? [],
    nextAfter: data.paging?.next?.after,
  }
}

async function fetchAllCompanies(apiKey: string): Promise<HubSpotCompany[]> {
  const all: HubSpotCompany[] = []
  let after: string | undefined
  let page = 0

  while (page < MAX_PAGES) {
    const { results, nextAfter } = await fetchCompaniesPage(apiKey, after)
    all.push(...results)
    if (!nextAfter) break
    after = nextAfter
    page++
  }

  return all
}

// ── Auto-matching helpers ────────────────────────────────────

/**
 * Crée la propriété custom 'id_stripe' sur les companies HubSpot (idempotente).
 * Cette propriété reçoit le stripe_customer_id lors du reverse-push,
 * et permet l'auto-matching automatique lors des futures syncs.
 * Non-bloquant : 409 (déjà existante) et erreurs de scope sont silencieuses.
 */
async function ensureIdStripeProperty(apiKey: string): Promise<void> {
  try {
    const check = await fetchWithTimeout(
      `${HUBSPOT_BASE_URL}/crm/v3/properties/companies/id_stripe`,
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } },
      8000,
    )
    if (check.ok) return
  } catch { /* try to create anyway */ }

  try {
    await fetchWithTimeout(
      `${HUBSPOT_BASE_URL}/crm/v3/properties/companies`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'id_stripe',
          label: 'Stripe Customer ID',
          type: 'string',
          fieldType: 'text',
          groupName: 'companyinformation',
          description: 'Identifiant Stripe (cus_xxx) pour le matching automatique Sentio AI',
        }),
      },
      8000,
    )
  } catch {
    // Scope manquant ou propriété déjà existante — non-bloquant
  }
}

/**
 * Pousse le stripe_customer_id Sentio vers la propriété 'id_stripe' de la company HubSpot.
 * Permet aux futures syncs de retrouver le lien automatiquement.
 * Non-bloquant, best-effort.
 */
async function reversePushStripeIds(
  supabase: SupabaseClient,
  orgId: string,
  apiKey: string,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const { data: linked } = await supabase
    .from('accounts')
    .select('id, hubspot_company_id, stripe_customer_id')
    .eq('organization_id', orgId)
    .not('hubspot_company_id', 'is', null)
    .not('stripe_customer_id', 'is', null)
    .limit(1000)

  if (!linked?.length) return

  // Filtrer : seulement les vrais IDs HubSpot numériques
  const eligible = linked.filter(a => /^[0-9]+$/.test(a.hubspot_company_id ?? ''))
  const pushList = computeReversePushList(
    eligible.map(a => ({ hubspot_company_id: a.hubspot_company_id!, account_id: a.id })),
    eligible.map(a => ({ id: a.id, stripe_customer_id: a.stripe_customer_id })),
  )

  if (pushList.length === 0) return

  let pushed = 0
  for (const batch of batchArray(pushList, 100)) {
    try {
      await hubspotRateLimiter.waitForToken()
      const res = await fetchWithTimeout(
        `${HUBSPOT_BASE_URL}/crm/v3/objects/companies/batch/update`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputs: batch.map(p => ({ id: p.hubspot_company_id, properties: { id_stripe: p.stripe_customer_id } })),
          }),
        },
        10000,
      )
      if (res.ok) pushed += batch.length
    } catch (err) {
      logger.warn('reverse-push id_stripe batch failed', { error: String(err), organization_id: orgId })
    }
  }

  if (pushed > 0) logger.info('Reverse-pushed id_stripe to HubSpot', { count: pushed, organization_id: orgId })
}

// ── Sync logic ───────────────────────────────────────────────

async function syncOrgHubSpot(
  supabase: SupabaseClient,
  orgId: string,
  apiKey: string,
  logger: ReturnType<typeof createLogger>,
): Promise<{ companiesFound: number; accountsMatched: number; accountsUpdated: number; autoLinked: number }> {

  // 1. S'assurer que la propriété id_stripe existe dans HubSpot (idempotent)
  await ensureIdStripeProperty(apiKey)

  // 2. Charger tous les comptes de l'org (liés et non-liés) pour le matching
  const { data: allAccounts } = await supabase
    .from('accounts')
    .select('id, hubspot_company_id, stripe_customer_id')
    .eq('organization_id', orgId)
    .limit(10000)

  const accountMap   = buildHubspotIdMap(allAccounts ?? [])   // hsId → accountId (déjà liés)
  const stripeMap    = buildStripeIdMap(allAccounts ?? [])     // stripeId → accountId (auto-match)

  if (accountMap.size === 0 && stripeMap.size === 0) {
    logger.info('No accounts for this org — skipping', { organization_id: orgId })
    return { companiesFound: 0, accountsMatched: 0, accountsUpdated: 0, autoLinked: 0 }
  }

  // 3. Paginer les companies HubSpot (inclut id_stripe pour l'auto-matching)
  const companies = await fetchAllCompanies(apiKey)
  logger.info('HubSpot companies fetched', { count: companies.length, organization_id: orgId })

  // 4. Préparer les upserts — auto-matching via id_stripe si pas encore lié
  const now = new Date().toISOString()
  const rows: Record<string, unknown>[] = []
  let autoLinked = 0

  for (const company of companies) {
    const accountId = matchCompanyToAccount(company, stripeMap, accountMap)
    if (!accountId) continue

    // Auto-linking : mettre à jour accounts.hubspot_company_id si nouveau lien
    if (!accountMap.has(company.id)) {
      const { error: linkErr } = await supabase
        .from('accounts')
        .update({ hubspot_company_id: company.id })
        .eq('id', accountId)
        .eq('organization_id', orgId)

      if (!linkErr) {
        accountMap.set(company.id, accountId)
        autoLinked++
        logger.info('Auto-linked account', {
          hubspot_company_id: company.id,
          account_id: accountId,
          organization_id: orgId,
        })
      } else {
        logger.error('Auto-link failed', { error: linkErr.message, organization_id: orgId })
        continue
      }
    }

    const mapped = mapHubSpotProperties(company.properties)
    rows.push({
      organization_id:    orgId,
      account_id:         accountId,
      hubspot_company_id: company.id,
      ...mapped,
      last_synced_at:     now,
    })
  }

  const accountsMatched = rows.length

  // 5. Upsert par batch dans hubspot_companies
  let accountsUpdated = 0
  for (let i = 0; i < rows.length; i += DB_BATCH_SIZE) {
    const batch = rows.slice(i, i + DB_BATCH_SIZE)
    const { error } = await supabase
      .from('hubspot_companies')
      .upsert(batch, { onConflict: 'organization_id,account_id' })

    if (error) {
      logger.error('Upsert batch failed', { organization_id: orgId, error: error.message })
    } else {
      accountsUpdated += batch.length
    }
  }

  // 6. Mettre à jour last_hubspot_sync_at
  const accountIds = rows.map((r) => r.account_id as string)
  if (accountIds.length > 0) {
    await supabase
      .from('accounts')
      .update({ last_hubspot_sync_at: now })
      .eq('organization_id', orgId)
      .in('id', accountIds)
  }

  // 7. Reverse-push : écrire stripe_customer_id sur les companies HubSpot nouvellement liées
  //    Permet l'auto-matching automatique lors des futures syncs (non-bloquant)
  await reversePushStripeIds(supabase, orgId, apiKey, logger)

  return { companiesFound: companies.length, accountsMatched, accountsUpdated, autoLinked }
}

// ── Entrypoint ───────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  let supabase: SupabaseClient
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: LOCK_KEY, message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  let body: SyncHubSpotBody = {}
  try {
    body = await req.json() as SyncHubSpotBody
  } catch {
    // body optionnel
  }

  const correlationId = crypto.randomUUID()
  const logger = createLogger({
    correlation_id: correlationId,
    function_name: LOCK_KEY,
    organization_id: body.organization_id,
  })

  logger.info('sync-hubspot invoked', { organization_id: body.organization_id ?? null, sync_type: body.sync_type ?? null })

  // Résoudre la ou les orgs à synchroniser
  let orgsToSync: Array<{ id: string; hubspot_api_key: string }> = []

  try {
    if (body.organization_id) {
      const apiKey = await resolveHubSpotApiKey(supabase, body.organization_id)
      if (apiKey) {
        orgsToSync = [{ id: body.organization_id, hubspot_api_key: apiKey }]
      } else {
        logger.warn('No HubSpot credentials found for org', { organization_id: body.organization_id })
      }
    } else {
      // Cron : récupérer toutes les orgs avec HubSpot actif
      // Priorité : organization_integrations (Vault) puis organizations.hubspot_api_key
      const [{ data: integratedOrgs }, { data: legacyOrgs }] = await Promise.all([
        supabase
          .from('organization_integrations')
          .select('organization_id, vault_access_token_id')
          .eq('provider', 'hubspot')
          .eq('status', 'active')
          .not('vault_access_token_id', 'is', null),
        supabase
          .from('organizations')
          .select('id, hubspot_api_key')
          .not('hubspot_api_key', 'is', null)
          .eq('hubspot_connected', true),
      ])

      // Merge : Vault en priorité
      const seen = new Set<string>()
      for (const i of integratedOrgs ?? []) {
        const key = await getVaultSecret(supabase, i.vault_access_token_id)
        if (key) {
          seen.add(i.organization_id)
          orgsToSync.push({ id: i.organization_id, hubspot_api_key: key })
        }
      }
      for (const o of legacyOrgs ?? []) {
        if (!seen.has(o.id) && o.hubspot_api_key) {
          orgsToSync.push({ id: o.id, hubspot_api_key: o.hubspot_api_key })
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('Org resolution failed', { error: msg })
    return errorResponse(`Failed to resolve organizations: ${msg}`, 500)
  }

  if (orgsToSync.length === 0) {
    logger.info('No organizations with HubSpot configured')
    return jsonResponse({ success: true, message: 'No HubSpot organizations to sync', synced: 0 })
  }

  // Cron lock (évite les runs concurrents)
  let lockAcquired = false
  try {
    lockAcquired = await acquireCronLock(supabase, LOCK_KEY, LOCK_TTL_SECONDS)
  } catch (err) {
    logger.warn('Cron lock failed', { error: String(err) })
    // Continue without lock rather than crashing
    lockAcquired = true
  }
  if (!lockAcquired) {
    logger.info('Sync already running, skipping')
    return jsonResponse({ success: true, message: 'Sync already in progress', synced: 0 })
  }

  const results: Array<{
    organization_id: string
    companies_found: number
    accounts_matched: number
    accounts_updated: number
    auto_linked: number
    error?: string
  }> = []

  try {
    for (const org of orgsToSync) {
      const syncLogger = new DataSyncLogger({
        supabase,
        organizationId: org.id,
        syncSource: 'hubspot',
        syncType: body.sync_type === 'full_sync' ? 'full_sync' : 'incremental',
        triggeredBy: body.triggered_by === 'onboarding' ? 'manual' : (body.is_manual ? 'manual' : 'cron'),
      })
      await syncLogger.start()

      try {
        const { companiesFound, accountsMatched, accountsUpdated, autoLinked } = await syncOrgHubSpot(
          supabase,
          org.id,
          org.hubspot_api_key,
          logger,
        )

        syncLogger.increment('records_processed', accountsUpdated)
        await syncLogger.complete({ companies_found: companiesFound, accounts_matched: accountsMatched, auto_linked: autoLinked })

        results.push({
          organization_id: org.id,
          companies_found: companiesFound,
          accounts_matched: accountsMatched,
          accounts_updated: accountsUpdated,
          auto_linked: autoLinked,
        })

        logger.info('Org sync complete', { organization_id: org.id, accountsUpdated, autoLinked })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('Org sync failed', { organization_id: org.id, error: msg })
        await syncLogger.fail(msg)
        await alertSlack(`sync-hubspot: org ${org.id} failed — ${msg}`, { level: 'warning' })
        results.push({ organization_id: org.id, companies_found: 0, accounts_matched: 0, accounts_updated: 0, auto_linked: 0, error: msg })
      }
    }

    logger.info('Sync run complete', { orgs: results.length })
    return jsonResponse({ success: true, synced: results.length, results })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('Global sync failure', { error: msg })
    await alertSlack(`sync-hubspot: global failure — ${msg}`, { level: 'critical' })
    return errorResponse(`Sync failed: ${msg}`, 500)
  } finally {
    try {
      await releaseCronLock(supabase, LOCK_KEY)
    } catch (lockErr) {
      console.error(JSON.stringify({
        level: 'error',
        function_name: LOCK_KEY,
        message: `Failed to release cron lock: ${lockErr instanceof Error ? lockErr.message : String(lockErr)}`,
      }))
    }
  }
})
