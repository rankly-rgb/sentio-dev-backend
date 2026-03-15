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
import { resolveCredentialSource } from '../_shared/credential-helpers.ts'

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

interface HubSpotV4AssociationResponse {
  results: Array<{ toObjectId: number }>
  paging?: { next?: { after: string } }
}

interface HubSpotBatchReadResponse {
  results: Array<{
    id: string
    properties: { hs_meeting_start_time?: string | null }
  }>
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
  const { data: integration } = await supabase
    .from('organization_integrations')
    .select('vault_access_token_id, provider_account_id, status, token_expires_at, integration_method')
    .eq('organization_id', organizationId)
    .eq('provider', 'hubspot')
    .eq('status', 'active')
    .maybeSingle()

  const vaultSecret = integration?.vault_access_token_id
    ? await getVaultSecret(supabase, integration.vault_access_token_id)
    : null

  // resolveCredentialSource throws si integration active + Vault echoue (pas de fallback silencieux)
  const source = resolveCredentialSource(integration, vaultSecret, 'hubspot')

  if (source.type === 'oauth' || source.type === 'api_key') {
    return {
      accessToken: vaultSecret!,
      portalId: source.providerAccountId,
    }
  }

  // Fallback global : uniquement si AUCUNE integration n'existe
  const globalKey = Deno.env.get('HUBSPOT_API_KEY')
  if (globalKey) {
    console.warn(JSON.stringify({
      level: 'warn',
      function_name: 'sync-hubspot',
      message: 'No integration found — using global HUBSPOT_API_KEY fallback',
      organization_id: organizationId,
    }))
    return { accessToken: globalKey, portalId: null }
  }

  throw new Error('No HubSpot credentials available: no token and no global key')
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
// id_stripe = custom property HubSpot contenant le stripe_customer_id (pour auto-mapping)
const COMPANY_PROPERTIES = [
  'hs_object_id',
  'lifecyclestage',
  'num_associated_deals',
  'id_stripe',
]

async function syncCompanies(
  supabase: SupabaseClient,
  organizationId: string,
  accessToken: string,
  logger: DataSyncLogger,
): Promise<void> {
  let after: string | undefined
  let page = 0

  // Pre-construire les Maps pour le matching bidirectionnel
  // 1. accountsByHsId : comptes deja lies par hubspot_company_id
  // 2. accountsByStripeId : comptes lies par stripe_customer_id (pour auto-mapping)
  const { data: allAccounts } = await supabase
    .from('accounts')
    .select('id, hubspot_company_id, stripe_customer_id')
    .eq('organization_id', organizationId)
    .limit(10000)

  if (!allAccounts || allAccounts.length === 0) {
    console.log(JSON.stringify({
      level: 'info',
      function_name: 'sync-hubspot',
      message: 'No accounts in org — skipping company sync',
      organization_id: organizationId,
    }))
    return
  }

  // Map hubspot_company_id → account_id (comptes deja lies)
  const accountsByHsId = new Map<string, string>()
  // Map stripe_customer_id → account_id (pour auto-mapping via id_stripe HubSpot)
  const accountsByStripeId = new Map<string, string>()
  for (const a of allAccounts) {
    if (a.hubspot_company_id) {
      accountsByHsId.set(a.hubspot_company_id, a.id)
    }
    if (a.stripe_customer_id) {
      accountsByStripeId.set(a.stripe_customer_id, a.id)
    }
  }

  let autoLinkedCount = 0

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
      let accountId = accountsByHsId.get(hsCompanyId)

      // Auto-mapping : si pas encore lie, matcher via id_stripe → stripe_customer_id
      if (!accountId) {
        const stripeIdFromHubspot = company.properties.id_stripe?.trim()
        if (stripeIdFromHubspot) {
          accountId = accountsByStripeId.get(stripeIdFromHubspot)
          if (accountId) {
            // Lier le compte : ecrire hubspot_company_id sur l'account
            const { error: linkError } = await supabase
              .from('accounts')
              .update({ hubspot_company_id: hsCompanyId })
              .eq('id', accountId)
              .eq('organization_id', organizationId)

            if (linkError) {
              console.error(`[sync-hubspot] auto-link error: ${linkError.message}`)
            } else {
              autoLinkedCount++
              accountsByHsId.set(hsCompanyId, accountId)
              console.log(JSON.stringify({
                level: 'info',
                function_name: 'sync-hubspot',
                message: `Auto-linked HubSpot company ${hsCompanyId} to account via stripe_customer_id ${stripeIdFromHubspot}`,
                organization_id: organizationId,
              }))
            }
          }
        }
      }

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

  if (autoLinkedCount > 0) {
    console.log(JSON.stringify({
      level: 'info',
      function_name: 'sync-hubspot',
      message: `Auto-linked ${autoLinkedCount} accounts via id_stripe property`,
      organization_id: organizationId,
    }))
  }
}

// ── Reverse-push id_stripe to HubSpot ────────────────────────
// Pour chaque compte Sentio lie a une company HubSpot, si la company
// n'a pas encore de propriete id_stripe, on pousse le stripe_customer_id.
// Cela permet le matching automatique dans les futures syncs et
// donne au CSM la visibilite Stripe directement dans HubSpot.

async function reversePushStripeIds(
  supabase: SupabaseClient,
  organizationId: string,
  accessToken: string,
  logger: DataSyncLogger,
): Promise<number> {
  // Get all linked accounts with stripe_customer_id
  const { data: linkedAccounts } = await supabase
    .from('hubspot_companies')
    .select('hubspot_company_id, account_id')
    .eq('organization_id', organizationId)
    .not('account_id', 'is', null)
    .limit(10000)

  if (!linkedAccounts || linkedAccounts.length === 0) return 0

  // Get stripe_customer_ids for these accounts
  const accountIds = linkedAccounts.map(a => a.account_id)
  const { data: accounts } = await supabase
    .from('accounts')
    .select('id, stripe_customer_id')
    .in('id', accountIds)
    .not('stripe_customer_id', 'is', null)

  if (!accounts || accounts.length === 0) return 0

  const stripeIdByAccountId = new Map<string, string>()
  for (const a of accounts) {
    if (a.stripe_customer_id) stripeIdByAccountId.set(a.id, a.stripe_customer_id)
  }

  // Batch update HubSpot companies with id_stripe (max 100 per batch)
  const updates: Array<{ id: string; properties: { id_stripe: string } }> = []
  for (const link of linkedAccounts) {
    const stripeId = stripeIdByAccountId.get(link.account_id)
    if (stripeId) {
      updates.push({
        id: link.hubspot_company_id,
        properties: { id_stripe: stripeId },
      })
    }
  }

  if (updates.length === 0) return 0

  let pushed = 0
  // HubSpot batch update: max 100 per request
  for (let i = 0; i < updates.length; i += 100) {
    const batch = updates.slice(i, i + 100)
    try {
      logger.increment('api_calls_made')
      await hubspotPost(
        '/crm/v3/objects/companies/batch/update',
        accessToken,
        { inputs: batch },
      )
      pushed += batch.length
    } catch (err) {
      // Non-bloquant : log et continue
      console.warn(JSON.stringify({
        level: 'warn',
        function_name: 'sync-hubspot',
        message: `Reverse-push id_stripe batch failed: ${err instanceof Error ? err.message : String(err)}`,
        organization_id: organizationId,
        batch_size: batch.length,
      }))
    }
  }

  if (pushed > 0) {
    console.log(JSON.stringify({
      level: 'info',
      function_name: 'sync-hubspot',
      message: `Reverse-pushed id_stripe to ${pushed} HubSpot companies`,
      organization_id: organizationId,
    }))
  }

  return pushed
}

// ── Ensure id_stripe property exists in HubSpot ──────────────
// Cree la propriete custom id_stripe sur les Companies HubSpot
// si elle n'existe pas encore. Appele une seule fois au debut de chaque sync.

async function ensureIdStripeProperty(
  accessToken: string,
): Promise<void> {
  try {
    // Check if property exists
    const checkResp = await fetchWithTimeout(
      `${HUBSPOT_API_BASE}/crm/v3/properties/companies/id_stripe`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      HUBSPOT_TIMEOUT_MS,
    )
    if (checkResp.ok) return // Property already exists
  } catch {
    // Check failed — try to create anyway
  }

  try {
    await hubspotPost(
      '/crm/v3/properties/companies',
      accessToken,
      {
        name: 'id_stripe',
        label: 'Stripe Customer ID',
        type: 'string',
        fieldType: 'text',
        groupName: 'companyinformation',
        description: 'Identifiant Stripe (cus_xxx) pour le matching automatique Sentio AI',
      },
    )
    console.log(JSON.stringify({
      level: 'info',
      function_name: 'sync-hubspot',
      message: 'Created id_stripe property on HubSpot Companies',
    }))
  } catch (err) {
    // Non-bloquant : la propriete existe peut-etre deja (409) ou scope manquant
    console.warn(JSON.stringify({
      level: 'warn',
      function_name: 'sync-hubspot',
      message: `Could not create id_stripe property: ${err instanceof Error ? err.message : String(err)}`,
    }))
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
// Utilise l'API associations v4 (la seule qui supporte le filtrage par company).
// L'API search v3 NE supporte PAS le filtrage par associations — elle retournait 0 résultats.

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

  for (const hc of hsCompanies) {
    try {
      // Étape 1 : récupérer les IDs des meetings liés à cette company via l'API associations v4
      logger.increment('api_calls_made')
      const assocResp = await hubspotGet<HubSpotV4AssociationResponse>(
        `/crm/v4/objects/companies/${hc.hubspot_company_id}/associations/meetings`,
        accessToken,
      )

      if (!assocResp.results || assocResp.results.length === 0) continue

      const meetingIds = assocResp.results.map((r) => ({ id: String(r.toObjectId) }))

      // Étape 2 : batch-read les propriétés des meetings (hs_meeting_start_time)
      logger.increment('api_calls_made')
      const batchResp = await hubspotPost<HubSpotBatchReadResponse>(
        '/crm/v3/objects/meetings/batch/read',
        accessToken,
        {
          inputs: meetingIds,
          properties: ['hs_meeting_start_time'],
        },
      )

      if (!batchResp.results || batchResp.results.length === 0) continue

      // Étape 3 : trouver la date de meeting la plus récente
      let latestMs = 0
      for (const meeting of batchResp.results) {
        const t = meeting.properties?.hs_meeting_start_time
        if (t) {
          const ms = new Date(t).getTime()
          if (!isNaN(ms) && ms > latestMs) latestMs = ms
        }
      }

      if (latestMs > 0) {
        const meetingDate = new Date(latestMs).toISOString().split('T')[0]
        await supabase
          .from('hubspot_companies')
          .update({ last_meeting_date: meetingDate })
          .eq('id', hc.id)
      }
    } catch (err) {
      // Non-bloquant — log pour visibilité sans arrêter la sync
      console.warn(JSON.stringify({
        level: 'warn',
        function_name: 'sync-hubspot',
        message: `Meeting sync failed for company ${hc.hubspot_company_id}: ${err instanceof Error ? err.message : String(err)}`,
        organization_id: organizationId,
      }))
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

  // Auth : verify_jwt = true dans config.toml
  // Le service_role HS256 JWT est validé automatiquement par le relay Supabase.
  // Appelants autorisés : cron (service_role), admin-proxy (service_role), triggerInitialSync (service_role).

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

    // 0. Ensure id_stripe property exists in HubSpot (idempotent, non-bloquant)
    await ensureIdStripeProperty(credentials.accessToken)

    // 1. Sync companies (core — always runs, includes auto-matching via id_stripe)
    await syncCompanies(supabase, organizationId, credentials.accessToken, logger)

    // 2. Reverse-push: pousser stripe_customer_id vers HubSpot id_stripe pour les comptes lies
    const reversePushed = await reversePushStripeIds(supabase, organizationId, credentials.accessToken, logger)

    // 3. Sync ticket counts (best-effort — scope may not be available)
    await syncTicketCounts(supabase, organizationId, credentials.accessToken, logger)

    // 4. Sync last meeting dates (best-effort — API-intensive, limited to synced companies)
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
