import { describe, it, expect } from 'vitest'
import {
  isStripeAccountConflict,
  findConflictingOrganization,
  STRIPE_ACCOUNT_CONFLICT_STATUS,
} from '../functions/_shared/stripe-account-claim.ts'

// ── Fonction pure miroir (update-stripe-connection/index.ts) ──
// Restreinte (rk_) ET secrète complète (sk_) toutes deux acceptées —
// aligné avec verify-stripe-token/integrations-config.
const VALID_PREFIXES = ['rk_live_', 'rk_test_', 'sk_live_', 'sk_test_'] as const
const MIN_SUFFIX_LENGTH = 20

function validateStripeKeyFormat(key: string): { valid: boolean; mode: 'live' | 'test' } {
  for (const prefix of VALID_PREFIXES) {
    if (key.startsWith(prefix) && key.length >= prefix.length + MIN_SUFFIX_LENGTH) {
      return { valid: true, mode: prefix.includes('live') ? 'live' : 'test' }
    }
  }
  return { valid: false, mode: 'test' }
}

describe('validateStripeKeyFormat', () => {
  it('accepts a well-formed rk_test_ key', () => {
    const result = validateStripeKeyFormat(`rk_test_${'a'.repeat(24)}`)
    expect(result).toEqual({ valid: true, mode: 'test' })
  })

  it('accepts a well-formed rk_live_ key', () => {
    const result = validateStripeKeyFormat(`rk_live_${'a'.repeat(24)}`)
    expect(result).toEqual({ valid: true, mode: 'live' })
  })

  it('accepts a well-formed sk_test_ key', () => {
    const result = validateStripeKeyFormat(`sk_test_${'a'.repeat(24)}`)
    expect(result).toEqual({ valid: true, mode: 'test' })
  })

  it('accepts a well-formed sk_live_ key', () => {
    const result = validateStripeKeyFormat(`sk_live_${'a'.repeat(24)}`)
    expect(result).toEqual({ valid: true, mode: 'live' })
  })

  it('rejects a publishable key', () => {
    const result = validateStripeKeyFormat(`pk_test_${'a'.repeat(24)}`)
    expect(result.valid).toBe(false)
  })

  it('rejects a key that is too short after the prefix', () => {
    const result = validateStripeKeyFormat('rk_test_short')
    expect(result.valid).toBe(false)
  })

  it('rejects an empty string', () => {
    const result = validateStripeKeyFormat('')
    expect(result.valid).toBe(false)
  })

  it('rejects garbage input with no recognizable prefix', () => {
    const result = validateStripeKeyFormat('not-a-stripe-key-at-all')
    expect(result.valid).toBe(false)
  })

  it('accepts exactly at the minimum suffix length boundary', () => {
    const result = validateStripeKeyFormat(`rk_test_${'a'.repeat(MIN_SUFFIX_LENGTH)}`)
    expect(result.valid).toBe(true)
  })

  it('rejects one character below the minimum suffix length', () => {
    const result = validateStripeKeyFormat(`rk_test_${'a'.repeat(MIN_SUFFIX_LENGTH - 1)}`)
    expect(result.valid).toBe(false)
  })

  it('rejects one character below the minimum suffix length for sk_', () => {
    const result = validateStripeKeyFormat(`sk_test_${'a'.repeat(MIN_SUFFIX_LENGTH - 1)}`)
    expect(result.valid).toBe(false)
  })
})

// ── Garde d'unicité stripe_account_id (incident 2026-08-15) ──
// Import réel de _shared/stripe-account-claim.ts (pas de copie miroir) :
// zéro dépendance Deno-native au runtime, le specifier jsr: est aliasé par
// vitest.config.ts et SupabaseClient n'y sert que de type.

describe('isStripeAccountConflict', () => {
  it('recognizes the real 23505 error observed in production logs', () => {
    // Message exact relevé dans function_logs le 2026-08-15T06:37:51.
    expect(isStripeAccountConflict({
      code: '23505',
      message: 'duplicate key value violates unique constraint "organizations_stripe_account_id_key"',
    })).toBe(true)
  })

  it('recognizes a 23505 that names only the column', () => {
    expect(isStripeAccountConflict({
      code: '23505',
      message: 'duplicate key value violates unique constraint on stripe_account_id',
    })).toBe(true)
  })

  it('treats a 23505 with no readable message as a stripe_account_id conflict', () => {
    // Ces deux chemins n'écrivent aucune autre colonne unique — un 23505 y
    // est forcément celui-là.
    expect(isStripeAccountConflict({ code: '23505', message: '' })).toBe(true)
    expect(isStripeAccountConflict({ code: '23505' })).toBe(true)
  })

  it('does NOT claim a unique violation on a different constraint', () => {
    expect(isStripeAccountConflict({
      code: '23505',
      message: 'duplicate key value violates unique constraint "organizations_slug_key"',
    })).toBe(false)
  })

  it('does NOT claim a non-unique-violation error', () => {
    expect(isStripeAccountConflict({ code: '23503', message: 'foreign key violation' })).toBe(false)
    expect(isStripeAccountConflict({ code: '42P10', message: 'no unique constraint matches' })).toBe(false)
  })

  it('handles null/undefined without throwing', () => {
    expect(isStripeAccountConflict(null)).toBe(false)
    expect(isStripeAccountConflict(undefined)).toBe(false)
  })

  it('maps to HTTP 409, never 500', () => {
    expect(STRIPE_ACCOUNT_CONFLICT_STATUS).toBe(409)
  })
})

describe('findConflictingOrganization', () => {
  // Stub minimal reproduisant la chaîne PostgREST utilisée par la fonction.
  function stubClient(result: { data: { id: string } | null; error: { message: string } | null }) {
    const calls: Record<string, unknown> = {}
    const builder = {
      select: () => builder,
      eq: (col: string, val: string) => { calls[`eq:${col}`] = val; return builder },
      neq: (col: string, val: string) => { calls[`neq:${col}`] = val; return builder },
      limit: () => builder,
      maybeSingle: () => Promise.resolve(result),
    }
    // deno-lint-ignore no-explicit-any
    const client = { from: (t: string) => { calls.table = t; return builder } } as any
    return { client, calls }
  }

  it('returns the conflicting org id when another org holds the account', async () => {
    const { client, calls } = stubClient({ data: { id: 'other-org' }, error: null })
    const result = await findConflictingOrganization(client, 'acct_123', 'my-org')

    expect(result).toEqual({ conflictingOrgId: 'other-org', lookupFailed: false })
    expect(calls.table).toBe('organizations')
    expect(calls['eq:stripe_account_id']).toBe('acct_123')
    // Le .neq est ce qui permet de se reconnecter à SON PROPRE compte.
    expect(calls['neq:id']).toBe('my-org')
  })

  it('returns no conflict when the account is free', async () => {
    const { client } = stubClient({ data: null, error: null })
    expect(await findConflictingOrganization(client, 'acct_free', 'my-org'))
      .toEqual({ conflictingOrgId: null, lookupFailed: false })
  })

  it('reports lookupFailed rather than a false "no conflict" on read error', async () => {
    // S1 : no data ≠ neutral data — une panne de lecture ne doit pas se lire
    // comme "aucun conflit", mais ne doit pas non plus bloquer : l'appelant
    // laisse la contrainte DB trancher.
    const { client } = stubClient({ data: null, error: { message: 'connection reset' } })
    expect(await findConflictingOrganization(client, 'acct_123', 'my-org'))
      .toEqual({ conflictingOrgId: null, lookupFailed: true })
  })
})
