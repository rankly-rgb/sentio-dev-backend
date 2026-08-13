import { describe, it, expect } from 'vitest'

// ── Types/logique miroir (stripe-billing-webhook/index.ts) ────
// (jsr: imports Deno-natifs non résolvables sous Vitest — même convention
// que les autres Edge Functions non structurées en fonctions pures dans
// _shared/. resolveOrgIdAndTier et la construction du timestamp/filtre
// n'ont pas de dépendance externe, seule la copie ici est nécessaire.)

type SubscriptionTierKey = 'free' | 'growth' | 'scale' | 'enterprise'
const VALID_TIERS: SubscriptionTierKey[] = ['free', 'growth', 'scale', 'enterprise']

function isSubscriptionTierKey(value: string | null | undefined): value is SubscriptionTierKey {
  return value !== null && value !== undefined && (VALID_TIERS as string[]).includes(value)
}

function resolveOrgIdAndTier(
  obj: Record<string, unknown>,
): { organizationId: string | null; tier: SubscriptionTierKey | null } {
  const metadata = (obj.metadata as Record<string, string> | null) ?? null
  const organizationId = (obj.client_reference_id as string | undefined) ?? metadata?.organization_id ?? null
  const metaTier = metadata?.tier
  const tier = isSubscriptionTierKey(metaTier) ? metaTier : null
  return { organizationId, tier }
}

function eventCreatedToIso(eventCreatedEpochSeconds: number): string {
  return new Date(eventCreatedEpochSeconds * 1000).toISOString()
}

function buildOrderingGuardFilter(eventCreatedIso: string): string {
  return `billing_event_at.is.null,billing_event_at.lt.${eventCreatedIso}`
}

describe('resolveOrgIdAndTier', () => {
  it('resolves organization_id from client_reference_id when present', () => {
    const result = resolveOrgIdAndTier({ client_reference_id: 'org-1', metadata: { organization_id: 'org-2' } })
    expect(result.organizationId).toBe('org-1')
  })

  it('falls back to metadata.organization_id when client_reference_id is absent', () => {
    const result = resolveOrgIdAndTier({ metadata: { organization_id: 'org-2' } })
    expect(result.organizationId).toBe('org-2')
  })

  it('returns null organizationId when neither source is present', () => {
    const result = resolveOrgIdAndTier({})
    expect(result.organizationId).toBeNull()
  })

  it('resolves a valid tier from metadata', () => {
    const result = resolveOrgIdAndTier({ metadata: { organization_id: 'org-1', tier: 'scale' } })
    expect(result.tier).toBe('scale')
  })

  it('returns null tier for an unrecognized value (never a silent wrong tier)', () => {
    const result = resolveOrgIdAndTier({ metadata: { organization_id: 'org-1', tier: 'starter' } })
    expect(result.tier).toBeNull()
  })

  it('returns null tier when metadata is absent entirely', () => {
    const result = resolveOrgIdAndTier({ client_reference_id: 'org-1' })
    expect(result.tier).toBeNull()
  })
})

describe('eventCreatedToIso', () => {
  it('converts Stripe epoch-seconds to a millisecond ISO string', () => {
    const expectedMs = Date.UTC(2026, 7, 13, 10, 0, 0) // 13 août 2026, 10:00 UTC
    expect(eventCreatedToIso(expectedMs / 1000)).toBe(new Date(expectedMs).toISOString())
  })
})

describe('ordering guard — issue "billing webhook has no idempotency/ordering protection"', () => {
  // La garde applique l'UPDATE conditionnellement (WHERE billing_event_at
  // IS NULL OR billing_event_at < event.created) en un seul appel atomique
  // — pas de lecture préalable, donc pas de fenêtre TOCTOU (même principe
  // que last_event_created_at dans stripe-webhook/index.ts).

  it('produces a well-formed PostgREST OR filter with no injected commas from the ISO string', () => {
    const iso = eventCreatedToIso(Date.UTC(2026, 7, 13, 10, 0, 0) / 1000)
    const filter = buildOrderingGuardFilter(iso)
    expect(filter).toBe(`billing_event_at.is.null,billing_event_at.lt.${iso}`)
    // Un ISO 8601 ne contient jamais de virgule — la valeur ne peut pas
    // casser accidentellement le parsing des deux conditions du filtre OR.
    expect(iso.includes(',')).toBe(false)
  })

  it('guard filter always accepts the first-ever event (billing_event_at IS NULL branch present)', () => {
    const filter = buildOrderingGuardFilter(eventCreatedToIso(Date.UTC(2026, 7, 13, 10, 0, 0) / 1000))
    expect(filter).toContain('billing_event_at.is.null')
  })
})
