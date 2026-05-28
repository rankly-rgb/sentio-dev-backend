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
import { mapHubSpotProperties, type HubSpotCompanyProperties } from '../_shared/hubspot-sync-helpers.ts'

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

// ── Sync logic ───────────────────────────────────────────────

async function syncOrgHubSpot(
  supabase: SupabaseClient,
  orgId: string,
  apiKey: string,
  logger: ReturnType<typeof createLogger>,
): Promise<{ companiesFound: number; accountsMatched: number; accountsUpdated: number }> {

  // 1. Charger la map hubspot_company_id → account_id pour cette org
  const { data: accounts } = await supabase
    .from('accounts')
    .select('id, hubspot_company_id')
    .eq('organization_id', orgId)
    .not('hubspot_company_id', 'is', null)

  const accountMap = new Map<string, string>()
  for (const acc of accounts ?? []) {
    if (acc.hubspot_company_id) accountMap.set(acc.hubspot_company_id, acc.id)
  }

  if (accountMap.size === 0) {
    logger.info('No accounts with hubspot_company_id — skipping', { organization_id: orgId })
    return { companiesFound: 0, accountsMatched: 0, accountsUpdated: 0 }
  }

  // 2. Paginer les companies HubSpot
  const companies = await fetchAllCompanies(apiKey)
  logger.info('HubSpot companies fetched', { count: companies.length, organization_id: orgId })

  // 3. Préparer les upserts pour les companies qui matchent un account Sentio
  const now = new Date().toISOString()
  const rows: Record<string, unknown>[] = []

  for (const company of companies) {
    const accountId = accountMap.get(company.id)
    if (!accountId) continue

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

  // 4. Upsert par batch
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

  // 5. Mettre à jour last_hubspot_sync_at sur les accounts matchés
  const accountIds = rows.map((r) => r.account_id as string)
  if (accountIds.length > 0) {
    await supabase
      .from('accounts')
      .update({ last_hubspot_sync_at: now })
      .eq('organization_id', orgId)
      .in('id', accountIds)
  }

  return { companiesFound: companies.length, accountsMatched, accountsUpdated }
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

  // Résoudre la ou les orgs à synchroniser
  let orgsToSync: Array<{ id: string; hubspot_api_key: string }> = []

  if (body.organization_id) {
    const { data } = await supabase
      .from('organizations')
      .select('id, hubspot_api_key')
      .eq('id', body.organization_id)
      .not('hubspot_api_key', 'is', null)
      .maybeSingle()

    if (data?.hubspot_api_key) {
      orgsToSync = [{ id: data.id, hubspot_api_key: data.hubspot_api_key }]
    }
  } else {
    const { data } = await supabase
      .from('organizations')
      .select('id, hubspot_api_key')
      .not('hubspot_api_key', 'is', null)
      .eq('hubspot_connected', true)

    orgsToSync = (data ?? []).filter((o) => o.hubspot_api_key)
  }

  if (orgsToSync.length === 0) {
    logger.info('No organizations with HubSpot configured')
    return jsonResponse({ success: true, message: 'No HubSpot organizations to sync', synced: 0 })
  }

  // Cron lock (évite les runs concurrents)
  const lockAcquired = await acquireCronLock(supabase, LOCK_KEY, LOCK_TTL_SECONDS)
  if (!lockAcquired) {
    logger.warn('Sync already running, skipping')
    return errorResponse('Sync already running', 409)
  }

  const results: Array<{
    organization_id: string
    companies_found: number
    accounts_matched: number
    accounts_updated: number
    error?: string
  }> = []

  try {
    for (const org of orgsToSync) {
      const syncLogger = new DataSyncLogger({
        supabase,
        organizationId: org.id,
        syncSource: 'hubspot',
        syncType: body.sync_type === 'full_sync' ? 'full' : 'incremental',
        triggeredBy: body.triggered_by === 'onboarding' ? 'manual' : (body.is_manual ? 'manual' : 'cron'),
      })
      await syncLogger.start()

      try {
        const { companiesFound, accountsMatched, accountsUpdated } = await syncOrgHubSpot(
          supabase,
          org.id,
          org.hubspot_api_key,
          logger,
        )

        syncLogger.increment('records_processed', accountsUpdated)
        await syncLogger.complete({ companies_found: companiesFound, accounts_matched: accountsMatched })

        results.push({
          organization_id: org.id,
          companies_found: companiesFound,
          accounts_matched: accountsMatched,
          accounts_updated: accountsUpdated,
        })

        logger.info('Org sync complete', { organization_id: org.id, accountsUpdated })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('Org sync failed', { organization_id: org.id, error: msg })
        await syncLogger.fail(msg)
        await alertSlack(`sync-hubspot: org ${org.id} failed — ${msg}`, { level: 'warning' })
        results.push({ organization_id: org.id, companies_found: 0, accounts_matched: 0, accounts_updated: 0, error: msg })
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
