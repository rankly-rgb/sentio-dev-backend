// ── Helpers purs pour sync-hubspot ─────────────────────────────
// Fonctions pures sans dependances Deno/jsr pour tests Vitest.

export interface AccountRow {
  id: string
  hubspot_company_id?: string | null
  stripe_customer_id?: string | null
}

export interface HubSpotCompanyProps {
  id: string
  properties: {
    id_stripe?: string | null
    [key: string]: string | null | undefined
  }
}

/**
 * Build a Map of stripe_customer_id → account_id for auto-matching.
 * Only includes accounts that have a stripe_customer_id set.
 */
export function buildStripeIdMap(accounts: AccountRow[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const a of accounts) {
    if (a.stripe_customer_id) {
      map.set(a.stripe_customer_id, a.id)
    }
  }
  return map
}

/**
 * Build a Map of hubspot_company_id → account_id for already-linked accounts.
 */
export function buildHubspotIdMap(accounts: AccountRow[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const a of accounts) {
    if (a.hubspot_company_id) {
      map.set(a.hubspot_company_id, a.id)
    }
  }
  return map
}

/**
 * Attempt to auto-match a HubSpot company to a Sentio account via id_stripe property.
 * Returns the account_id if matched, null otherwise.
 */
export function matchCompanyToAccount(
  company: HubSpotCompanyProps,
  accountsByStripeId: Map<string, string>,
  alreadyLinked: Map<string, string>,
): string | null {
  // Already linked by hubspot_company_id
  const existing = alreadyLinked.get(company.id)
  if (existing) return existing

  // Try id_stripe matching
  const stripeId = company.properties.id_stripe?.trim()
  if (!stripeId) return null

  return accountsByStripeId.get(stripeId) ?? null
}

export interface ReversePushItem {
  hubspot_company_id: string
  stripe_customer_id: string
}

/**
 * Determine which linked accounts need their stripe_customer_id pushed to HubSpot.
 * Returns a list of {hubspot_company_id, stripe_customer_id} pairs.
 */
export function computeReversePushList(
  linkedAccounts: Array<{ hubspot_company_id: string; account_id: string }>,
  accounts: Array<{ id: string; stripe_customer_id: string | null }>,
): ReversePushItem[] {
  const stripeIdByAccountId = new Map<string, string>()
  for (const a of accounts) {
    if (a.stripe_customer_id) {
      stripeIdByAccountId.set(a.id, a.stripe_customer_id)
    }
  }

  const result: ReversePushItem[] = []
  for (const link of linkedAccounts) {
    const stripeId = stripeIdByAccountId.get(link.account_id)
    if (stripeId) {
      result.push({
        hubspot_company_id: link.hubspot_company_id,
        stripe_customer_id: stripeId,
      })
    }
  }
  return result
}

/**
 * Split a list into batches of a given size.
 */
export function batchArray<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize))
  }
  return batches
}
