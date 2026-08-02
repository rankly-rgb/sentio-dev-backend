import { describe, it, expect } from 'vitest'

// ── Fonction pure miroir (update-stripe-connection/index.ts) ──
// Restreinte uniquement (rk_) — contrairement à verify-stripe-token/
// integrations-config qui acceptent encore sk_, cet endpoint applique
// l'invariant "Stripe read-only" dès la mise à jour.
const VALID_PREFIXES = ['rk_live_', 'rk_test_'] as const
const MIN_SUFFIX_LENGTH = 20

function validateRestrictedKeyFormat(key: string): { valid: boolean; mode: 'live' | 'test' } {
  for (const prefix of VALID_PREFIXES) {
    if (key.startsWith(prefix) && key.length >= prefix.length + MIN_SUFFIX_LENGTH) {
      return { valid: true, mode: prefix.includes('live') ? 'live' : 'test' }
    }
  }
  return { valid: false, mode: 'test' }
}

describe('validateRestrictedKeyFormat', () => {
  it('accepts a well-formed rk_test_ key', () => {
    const result = validateRestrictedKeyFormat(`rk_test_${'a'.repeat(24)}`)
    expect(result).toEqual({ valid: true, mode: 'test' })
  })

  it('accepts a well-formed rk_live_ key', () => {
    const result = validateRestrictedKeyFormat(`rk_live_${'a'.repeat(24)}`)
    expect(result).toEqual({ valid: true, mode: 'live' })
  })

  it('rejects a full secret key (sk_test_) even though it is a valid Stripe key shape', () => {
    const result = validateRestrictedKeyFormat(`sk_test_${'a'.repeat(24)}`)
    expect(result.valid).toBe(false)
  })

  it('rejects a full secret key (sk_live_)', () => {
    const result = validateRestrictedKeyFormat(`sk_live_${'a'.repeat(24)}`)
    expect(result.valid).toBe(false)
  })

  it('rejects a publishable key', () => {
    const result = validateRestrictedKeyFormat(`pk_test_${'a'.repeat(24)}`)
    expect(result.valid).toBe(false)
  })

  it('rejects a key that is too short after the prefix', () => {
    const result = validateRestrictedKeyFormat('rk_test_short')
    expect(result.valid).toBe(false)
  })

  it('rejects an empty string', () => {
    const result = validateRestrictedKeyFormat('')
    expect(result.valid).toBe(false)
  })

  it('rejects garbage input with no recognizable prefix', () => {
    const result = validateRestrictedKeyFormat('not-a-stripe-key-at-all')
    expect(result.valid).toBe(false)
  })

  it('accepts exactly at the minimum suffix length boundary', () => {
    const result = validateRestrictedKeyFormat(`rk_test_${'a'.repeat(MIN_SUFFIX_LENGTH)}`)
    expect(result.valid).toBe(true)
  })

  it('rejects one character below the minimum suffix length', () => {
    const result = validateRestrictedKeyFormat(`rk_test_${'a'.repeat(MIN_SUFFIX_LENGTH - 1)}`)
    expect(result.valid).toBe(false)
  })
})
