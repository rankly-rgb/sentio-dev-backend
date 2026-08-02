import { describe, it, expect } from 'vitest'

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
