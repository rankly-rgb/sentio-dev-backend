import { describe, it, expect } from 'vitest'

// Mirror de la construction du log `portfolio_metrics_banner_state`
// (dashboard-api/index.ts::handlePortfolioMetrics) — même convention que
// sync-stripe-key-resolution.test.ts (imports jsr: en position valeur,
// non résolvables par Vitest).
//
// CONTEXTE (2026-08-19, mission "Stripe not connected" banner)
// ──────────────────────────────────────────────────────────
// Naima a signalé un bandeau "Stripe Not connected" vu sur l'Overview juste
// après un sync réussi. Deux bandeaux distincts peuvent se déclencher à
// partir de ce même payload (Dashboard.tsx) :
//   - StripeStaleBanner, sur `stripe_stale` (computeSyncFreshness ne trouve
//     aucune ligne data_syncs `sync_status='completed'` pour stripe, ou le
//     dernier sync complet a plus de 48h)
//   - BillingProfileNeedsReviewBanner, sur `billing_profile==='needs_review'`
//     (org avec des comptes invoice-only/metered/multi-devise)
// Aucune preuve serveur ne permettait de trancher laquelle s'était
// réellement déclenchée dans sa session — ce log rend la prochaine
// occurrence auto-diagnosticable via query_logs (grep organization_id +
// horodatage) sans reproduction live.

interface SyncFreshnessLike {
  stale: boolean
  lastSyncHoursAgo: number | null
}

interface BannerStateLog {
  level: 'info'
  function_name: 'dashboard-api'
  route: 'portfolio-metrics'
  event: 'portfolio_metrics_banner_state'
  organization_id: string
  billing_profile: 'standard' | 'needs_review' | null
  stripe_stale: boolean
  stripe_last_sync_hours_ago: number | null
  banner_stripe_stale_would_render: boolean
  banner_billing_profile_needs_review_would_render: boolean
  accounts_count: number
  mrr_unavailable_accounts: number
}

/** Mirror exact de la construction du log dans handlePortfolioMetrics. */
function buildBannerStateLog(
  orgId: string,
  billingProfile: 'standard' | 'needs_review' | null,
  stripeFreshness: SyncFreshnessLike,
  accountsCount: number,
  mrrUnavailableAccounts: number,
): BannerStateLog {
  return {
    level: 'info',
    function_name: 'dashboard-api',
    route: 'portfolio-metrics',
    event: 'portfolio_metrics_banner_state',
    organization_id: orgId,
    billing_profile: billingProfile,
    stripe_stale: stripeFreshness.stale,
    stripe_last_sync_hours_ago: stripeFreshness.lastSyncHoursAgo,
    banner_stripe_stale_would_render: stripeFreshness.stale,
    banner_billing_profile_needs_review_would_render: billingProfile === 'needs_review',
    accounts_count: accountsCount,
    mrr_unavailable_accounts: mrrUnavailableAccounts,
  }
}

describe('dashboard-api — portfolio_metrics_banner_state log', () => {
  it('flags the stale banner as would-render when stripe_stale is true', () => {
    const log = buildBannerStateLog('org-1', 'standard', { stale: true, lastSyncHoursAgo: 72.3 }, 5, 0)
    expect(log.banner_stripe_stale_would_render).toBe(true)
    expect(log.banner_billing_profile_needs_review_would_render).toBe(false)
    expect(log.stripe_last_sync_hours_ago).toBe(72.3)
  })

  it('REGRESSION: a sync that just completed (fresh) never flags the stale banner', () => {
    // Reproduces the org from the App'Ines investigation: sync-stripe
    // completed 17:31:56->17:31:59, well under the 48h threshold.
    const log = buildBannerStateLog('org-2', 'needs_review', { stale: false, lastSyncHoursAgo: 0.001 }, 5, 3)
    expect(log.banner_stripe_stale_would_render).toBe(false)
    expect(log.banner_billing_profile_needs_review_would_render).toBe(true)
  })

  it('never confuses "no completed sync row found" (lastSyncHoursAgo: null) with a fresh sync', () => {
    const log = buildBannerStateLog('org-3', 'standard', { stale: true, lastSyncHoursAgo: null }, 0, 0)
    expect(log.stripe_last_sync_hours_ago).toBeNull()
    expect(log.banner_stripe_stale_would_render).toBe(true)
  })

  it('both banners can be flagged simultaneously — they are independent triggers', () => {
    const log = buildBannerStateLog('org-4', 'needs_review', { stale: true, lastSyncHoursAgo: 96 }, 5, 3)
    expect(log.banner_stripe_stale_would_render).toBe(true)
    expect(log.banner_billing_profile_needs_review_would_render).toBe(true)
  })

  it('neither banner is flagged for a healthy, fully-priced, recently-synced org', () => {
    const log = buildBannerStateLog('org-5', 'standard', { stale: false, lastSyncHoursAgo: 2 }, 40, 0)
    expect(log.banner_stripe_stale_would_render).toBe(false)
    expect(log.banner_billing_profile_needs_review_would_render).toBe(false)
  })

  it('billing_profile null (org predating the column, or never synced) never renders the needs_review banner', () => {
    const log = buildBannerStateLog('org-6', null, { stale: false, lastSyncHoursAgo: 1 }, 10, 0)
    expect(log.banner_billing_profile_needs_review_would_render).toBe(false)
  })

  it('echoes accounts_count and mrr_unavailable_accounts verbatim for cross-reference with the KPI captions', () => {
    const log = buildBannerStateLog('org-7', 'needs_review', { stale: false, lastSyncHoursAgo: 5 }, 5, 3)
    expect(log.accounts_count).toBe(5)
    expect(log.mrr_unavailable_accounts).toBe(3)
  })
})
