// ============================================================
// Edge Function : sync-hubspot
// Synchronise HubSpot → Supabase (companies, deals, tickets, meetings)
// Declenche par cron ou manuellement apres OAuth callback.
// Auth : service_role uniquement (verify_jwt = true)
// Zero-PII : uniquement hubspot_company_id + metriques agregees
// ============================================================
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { DataSyncLogger } from '../_shared/data-sync-logger.ts'
import { acquireCronLock, releaseCronLock } from '../_shared/cron-lock.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'
import { retryWithBackoff } from '../_shared/retry-with-backoff.ts'
import { CircuitBreaker } from '../_shared/circuit-breaker.ts'
import { alertSlack } from '../_shared/slack-alert.ts'
import { getVaultSecret } from '../_shared/vault.ts'

const HUBSPOT_API_BASE = 'https://api.hubapi.com'
const PAGE_SIZE = 100
const MAX_PAGES = 50
const HUBSPOT_TIMEOUT_MS = 8000

const hubspotCircuitBreaker = new CircuitBreaker({
  name: 'hubspot-api',
  failureThreshold: 5,
  resetTimeoutMs: 60000,
})

// ── HubSpot API Types ────────────────────────────────────────

interface HubSpotCompany {
  id: string
  properties: {
    hs_object_id?: string
    lifecyclestage?: string
    num_associated_deals?: string
    [key: string]: string | undefined
  }
}

interface HubSpotSearchResponse {
  results: HubSpotCompany[]
  paging?: { next?: { after: string } }
  total: number
}

interface HubSpotAssociationResponse {
  results: Array<{ id: string; type: string }>
}

// ── Credentials OAuth par org ────────────────────────────────

interface HubSpotCredentials {
  accessToken: string
  portalId: string | null
}

async function getHubSpotCredentials(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<HubSpotCredentials> {
  // Priorite 1 : token OAuth par org depuis Vault
  const { data: integration } = await supabase
    .from('organization_integrations')
    .select('vault_access_token_id, provider_account_id, status, token_expires_at')
    .eq('organization_id', organizationId)
    .eq('provider', 'hubspot')
    .eq('status', 'active')
    .maybeSingle()

  if (integration?.vault_access_token_id) {
    // Verifier si le token est expire
    if (integration.token_expires_at) {
      const expiresAt = new Date(integration.token_expires_at).getTime()
      if (expiresAt <= Date.now()) {
        throw new Error('HubSpot token expired — run refresh-hubspot-tokens first')
      }
    }

    const accessToken = await getVaultSecret(supabase, integration.vault_access_token_id)
    if (accessToken) {
      return {
        accessToken,
        portalId: integration.provider_account_id,
      }
    }
  }

  // Fallback temporaire : cle API globale depuis env var
  const globalKey = Deno.env.get('HUBSPOT_API_KEY')
  if (globalKey) {
    console.warn(JSON.stringify({
      level: 'warn',
      function_name: 'sync-hubspot',
      message: 'Using global HUBSPOT_API_KEY fallback — org needs OAuth migration',
      organization_id: organizationId,
    }))
    return { accessToken: globalKey, portalId: null }
  }

  throw new Error('No HubSpot credentials available: no OAuth token and no global key')
}

// ── HubSpot API Helpers ──────────────────────────────────────

async function hubspotGet<T>(
  path: string,
  accessToken: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${HUBSPOT_API_BASE}${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  }

  const resp = await retryWithBackoff(
    () => hubspotCircuitBreaker.execute(() =>
      fetchWithTimeout(
        url.toString(),
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        },
        HUBSPOT_TIMEOUT_MS,
      ),
    ),
    3,
  )

  if (!resp.ok) {
    const body = await resp.text().catch(() => 'unknown')
    throw new Error(`HubSpot API ${path} failed: ${resp.status} ${body.substring(0, 200)}`)
  }

  return resp.json()
}

async function hubspotPost<T>(
  path: string,
  accessToken: string,
  body: unknown,
): Promise<T> {
  const resp = await retryWithBackoff(
    () => hubspotCircuitBreaker.execute(() =>
      fetchWithTimeout(
        `${HUBSPOT_API_BASE}${path}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
        HUBSPOT_TIMEOUT_MS,
      ),
    ),
    3,
  )

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => 'unknown')
    throw new Error(`HubSpot API POST ${path} failed: ${resp.status} ${errBody.substring(0, 200)}`)
  }

  return resp.json()
}

// ── Sync Companies ───────────────────────────────────────────

// Zero-PII whitelist : seules ces proprietes sont lues depuis HubSpot
const COMPANY_PROPERTIES = [
  'hs_object_id',
  'lifecyclestage',
  'num_associated_deals',
]

async function syncCompanies(
  supabase: SupabaseClient,
  organizationId: string,
  accessToken: string,
  logger: DataSyncLogger,
): Promise<void> {
  let after: string | undefined
  let page = 0

  // Pre-construire une Map account_id par hubspot_company_id
  const { data: accounts } = await supabase
    .from('accounts')
    .select('id, hubspot_company_id')
    .eq('organization_id', organizationId)
    .not('hubspot_company_id', 'is', null)
    .limit(10000)

  if (!accounts || accounts.length === 0) {
    console.log(JSON.stringify({
      level: 'info',
      function_name: 'sync-hubspot',
      message: 'No accounts with hubspot_company_id — skipping company sync',
      organization_id: organizationId,
    }))
    return
  }

  const accountMap = new Map<string, string>()
  for (const a of accounts) {
    if (a.hubspot_company_id) {
      accountMap.set(a.hubspot_company_id, a.id)
    }
  }

  // Paginate companies via search API
  while (page < MAX_PAGES) {
    page++
    logger.increment('api_calls_made')

    const searchBody: Record<string, unknown> = {
      limit: PAGE_SIZE,
      properties: COMPANY_PROPERTIES,
      ...(after ? { after } : {}),
    }

    const result = await hubspotPost<HubSpotSearchResponse>(
      '/crm/v3/objects/companies/search',
      accessToken,
      searchBody,
    )

    for (const company of result.results) {
      const hsCompanyId = company.id
      const accountId = accountMap.get(hsCompanyId)
      if (!accountId) continue // Pas de compte Sentio lie a cette company HubSpot

      const lifecycleStage = normalizeLifecycleStage(
        company.properties.lifecyclestage,
      )
      const openDealCount = parseInt(company.properties.num_associated_deals ?? '0', 10) || 0

      const { error } = await supabase
        .from('hubspot_companies')
        .upsert(
          {
            organization_id: organizationId,
            account_id: accountId,
            hubspot_company_id: hsCompanyId,
            lifecycle_stage: lifecycleStage,
            open_deal_count: openDealCount,
            last_synced_at: new Date().toISOString(),
          },
          { onConflict: 'organization_id,account_id', ignoreDuplicates: false },
        )

      if (error) {
        console.error(`[sync-hubspot] upsert company error: ${error.message}`)
        logger.increment('records_failed')
      } else {
        logger.increment('records_processed')
        logger.increment('companies_processed')
      }
    }

    if (!result.paging?.next?.after) break
    after = result.paging.next.after
  }
}

// ── Sync Tickets (count per company) ─────────────────────────

async function syncTicketCounts(
  supabase: SupabaseClient,
  organizationId: string,
  accessToken: string,
  logger: DataSyncLogger,
): Promise<void> {
  // Get all hubspot_companies for this org to update ticket counts
  const { data: hsCompanies } = await supabase
    .from('hubspot_companies')
    .select('id, hubspot_company_id')
    .eq('organization_id', organizationId)
    .limit(10000)

  if (!hsCompanies || hsCompanies.length === 0) return

  // Query open tickets via search API with company associations
  // HubSpot CRM v3: search tickets then resolve company associations
  let after: string | undefined
  let page = 0
  const ticketsByCompany = new Map<string, number>()

  while (page < MAX_PAGES) {
    page++
    logger.increment('api_calls_made')

    const searchBody: Record<string, unknown> = {
      limit: PAGE_SIZE,
      properties: ['hs_object_id', 'hs_pipeline_stage'],
      filterGroups: [{
        filters: [{
          propertyName: 'hs_pipeline_stage',
          operator: 'NEQ',
          value: 'CLOSED',
        }],
      }],
      ...(after ? { after } : {}),
    }

    let result: HubSpotSearchResponse
    try {
      result = await hubspotPost<HubSpotSearchResponse>(
        '/crm/v3/objects/tickets/search',
        accessToken,
        searchBody,
      )
    } catch (err) {
      // Tickets scope may not be available — non-bloquant
      console.warn(`[sync-hubspot] Ticket search failed (scope may be missing): ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    // For each ticket, get its company association
    for (const ticket of result.results) {
      try {
        logger.increment('api_calls_made')
        const assocResp = await hubspotGet<HubSpotAssociationResponse>(
          `/crm/v4/objects/tickets/${ticket.id}/associations/companies`,
          accessToken,
        )
        for (const assoc of assocResp.results) {
          ticketsByCompany.set(
            assoc.id,
            (ticketsByCompany.get(assoc.id) ?? 0) + 1,
          )
        }
      } catch {
        // Association lookup failed — skip this ticket
      }
    }

    if (!result.paging?.next?.after) break
    after = result.paging.next.after
  }

  // Update ticket counts in batch
  for (const hc of hsCompanies) {
    const count = ticketsByCompany.get(hc.hubspot_company_id) ?? 0
    await supabase
      .from('hubspot_companies')
      .update({ open_ticket_count: count })
      .eq('id', hc.id)
  }
}

// ── Sync Last Meeting Date ───────────────────────────────────

async function syncLastMeetingDates(
  supabase: SupabaseClient,
  organizationId: string,
  accessToken: string,
  logger: DataSyncLogger,
): Promise<void> {
  const { data: hsCompanies } = await supabase
    .from('hubspot_companies')
    .select('id, hubspot_company_id')
    .eq('organization_id', organizationId)
    .limit(10000)

  if (!hsCompanies || hsCompanies.length === 0) return

  // For each company, check most recent meeting engagement
  for (const hc of hsCompanies) {
    try {
      logger.increment('api_calls_made')
      const result = await hubspotPost<HubSpotSearchResponse>(
        '/crm/v3/objects/meetings/search',
        accessToken,
        {
          limit: 1,
          properties: ['hs_meeting_start_time'],
          filterGroups: [{
            filters: [{
              propertyName: 'associations.company',
              operator: 'EQ',
              value: hc.hubspot_company_id,
            }],
          }],
          sorts: [{ propertyName: 'hs_meeting_start_time', direction: 'DESCENDING' }],
        },
      )

      if (result.results.length > 0) {
        const meetingTime = result.results[0].properties.hs_meeting_start_time
        if (meetingTime) {
          const meetingDate = new Date(meetingTime).toISOString().split('T')[0]
          await supabase
            .from('hubspot_companies')
            .update({ last_meeting_date: meetingDate })
            .eq('id', hc.id)
        }
      }
    } catch {
      // Meeting lookup failed — non-bloquant, continue
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────

function normalizeLifecycleStage(raw: string | undefined): string | null {
  if (!raw) return null
  const normalized = raw.toLowerCase().trim()
  const validStages = ['subscriber', 'customer', 'evangelist', 'other']
  return validStages.includes(normalized) ? normalized : 'other'
}

// ── Entrypoint ───────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  let body: { organization_id?: string; sync_type?: string }
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  const organizationId = body.organization_id
  if (!organizationId) {
    return errorResponse('organization_id is required', 400)
  }

  const syncType = body.sync_type === 'initial' ? 'initial' : 'daily'

  let supabase: SupabaseClient
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'sync-hubspot', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  // Cron lock (skip for initial syncs triggered by OAuth callback)
  const lockKey = `sync-hubspot-${organizationId}`
  if (syncType !== 'initial') {
    const locked = await acquireCronLock(supabase, lockKey, 300)
    if (!locked) {
      return jsonResponse({ skipped: true, reason: 'lock_held' })
    }
  }

  const logger = new DataSyncLogger({
    supabase,
    organizationId,
    syncSource: 'hubspot',
    syncType: syncType as 'initial' | 'daily',
    triggeredBy: syncType === 'initial' ? 'oauth_callback' : 'cron',
    isManual: false,
  })

  try {
    await logger.start()

    // Get HubSpot credentials from Vault
    const credentials = await getHubSpotCredentials(supabase, organizationId)

    // 1. Sync companies (core — always runs)
    await syncCompanies(supabase, organizationId, credentials.accessToken, logger)

    // 2. Sync ticket counts (best-effort — scope may not be available)
    await syncTicketCounts(supabase, organizationId, credentials.accessToken, logger)

    // 3. Sync last meeting dates (best-effort — API-intensive, limited to synced companies)
    await syncLastMeetingDates(supabase, organizationId, credentials.accessToken, logger)

    await logger.complete({
      sync_type: syncType,
      portal_id: credentials.portalId,
    })

    return jsonResponse({ success: true, sync_type: syncType })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'sync-hubspot',
      organization_id: organizationId,
      message: msg,
    }))
    await logger.fail(msg)
    await alertSlack(
      `sync-hubspot failed for org ${organizationId}: ${msg}`,
      { level: 'warning' },
    )
    return jsonResponse({ success: false, error: msg }, 500)
  } finally {
    if (syncType !== 'initial') {
      try { await releaseCronLock(supabase, lockKey) } catch { /* safety */ }
    }
  }
})
