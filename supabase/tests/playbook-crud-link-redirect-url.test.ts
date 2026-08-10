import { describe, it, expect } from 'vitest'
import { isValidHttpsUrl } from '../functions/playbook-crud/index'

// ── link_redirect_url validation (chantier C, T022) ──────────
// Écriture uniquement via playbook-crud (JWT + scoping organization_id
// déjà en place sur cet endpoint) — jamais interprétée depuis une
// requête de lien traçable (playbook-link).

describe('isValidHttpsUrl', () => {
  it('accepts a well-formed https:// URL', () => {
    expect(isValidHttpsUrl('https://example.com/thanks')).toBe(true)
  })

  it('rejects a non-https scheme', () => {
    expect(isValidHttpsUrl('http://example.com')).toBe(false)
  })

  it('rejects javascript: and data: schemes', () => {
    expect(isValidHttpsUrl('javascript:alert(1)')).toBe(false)
    expect(isValidHttpsUrl('data:text/html,hi')).toBe(false)
  })

  it('rejects a malformed string', () => {
    expect(isValidHttpsUrl('not a url')).toBe(false)
    expect(isValidHttpsUrl('')).toBe(false)
  })
})
