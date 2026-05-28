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
