// ============================================================
// HubSpot Sync Helpers — fonctions pures, sans dépendances Deno
// Exportées séparément pour être testables via Vitest
// ============================================================

export interface HubSpotCompanyProperties {
  lifecyclestage?: string | null
  num_open_deals?: string | null
  hs_ticket_count?: string | null
  hs_last_meeting_booked?: string | null
  notes_last_contacted?: string | null
  /** Propriété custom Sentio : stripe_customer_id poussé vers HubSpot pour l'auto-matching. */
  id_stripe?: string | null
}

// ── Auto-matching helpers (fonctions pures testables) ─────────

export interface AccountRow {
  id: string
  hubspot_company_id?: string | null
  stripe_customer_id?: string | null
}

export interface ReversePushItem {
  hubspot_company_id: string
  stripe_customer_id: string
}

/** Construit la map stripe_customer_id → account_id pour l'auto-matching. */
export function buildStripeIdMap(accounts: AccountRow[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const a of accounts) {
    if (a.stripe_customer_id) map.set(a.stripe_customer_id, a.id)
  }
  return map
}

/** Construit la map hubspot_company_id → account_id pour les comptes déjà liés. */
export function buildHubspotIdMap(accounts: AccountRow[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const a of accounts) {
    if (a.hubspot_company_id) map.set(a.hubspot_company_id, a.id)
  }
  return map
}

/**
 * Tente de matcher une company HubSpot à un compte Sentio.
 * Priorité : lien existant (hubspot_company_id) > id_stripe → stripe_customer_id.
 * Retourne l'account_id matché, ou null.
 */
export function matchCompanyToAccount(
  company: { id: string; properties: { id_stripe?: string | null } },
  accountsByStripeId: Map<string, string>,
  alreadyLinked: Map<string, string>,
): string | null {
  const existing = alreadyLinked.get(company.id)
  if (existing) return existing

  const stripeId = company.properties.id_stripe?.trim()
  if (!stripeId) return null

  return accountsByStripeId.get(stripeId) ?? null
}

/**
 * Détermine les comptes liés dont le stripe_customer_id doit être poussé
 * vers HubSpot (propriété id_stripe). Utilisé pour le reverse-push.
 */
export function computeReversePushList(
  linkedAccounts: Array<{ hubspot_company_id: string; account_id: string }>,
  accounts: Array<{ id: string; stripe_customer_id: string | null }>,
): ReversePushItem[] {
  const stripeById = new Map<string, string>()
  for (const a of accounts) {
    if (a.stripe_customer_id) stripeById.set(a.id, a.stripe_customer_id)
  }
  const result: ReversePushItem[] = []
  for (const link of linkedAccounts) {
    const stripeId = stripeById.get(link.account_id)
    if (stripeId) result.push({ hubspot_company_id: link.hubspot_company_id, stripe_customer_id: stripeId })
  }
  return result
}

/** Découpe un tableau en lots de `batchSize` éléments. */
export function batchArray<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize))
  }
  return batches
}

const VALID_LIFECYCLE_STAGES = ['subscriber', 'customer', 'evangelist', 'other'] as const
type LifecycleStage = typeof VALID_LIFECYCLE_STAGES[number]

export function normalizeLifecycleStage(stage: string | null | undefined): LifecycleStage | null {
  if (!stage) return null
  const lower = stage.toLowerCase()
  if (lower === 'customer') return 'customer'
  if (lower === 'evangelist') return 'evangelist'
  if (lower === 'subscriber') return 'subscriber'
  return 'other'  // lead, mql, sql, opportunity → other
}

export function parseHubSpotDate(value: string | null | undefined): string | null {
  if (!value) return null
  const d = new Date(value)
  if (isNaN(d.getTime())) return null
  return d.toISOString().split('T')[0]
}

export function parsePositiveInt(value: string | null | undefined): number {
  if (!value) return 0
  const n = parseInt(value, 10)
  return isNaN(n) || n < 0 ? 0 : n
}

export function mapHubSpotProperties(props: HubSpotCompanyProperties) {
  return {
    lifecycle_stage:   normalizeLifecycleStage(props.lifecyclestage),
    open_deal_count:   parsePositiveInt(props.num_open_deals),
    open_ticket_count: parsePositiveInt(props.hs_ticket_count),
    last_meeting_date: parseHubSpotDate(props.hs_last_meeting_booked),
    last_email_date:   parseHubSpotDate(props.notes_last_contacted),
  }
}
