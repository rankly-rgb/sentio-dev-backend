import { describe, it, expect } from 'vitest'

// ── Fonctions pures miroir (onboarding-status/index.ts) ───────

function determineCurrentStep(
  stripeConnected: boolean,
  hubspotConnected: boolean,
  firstWinSeen: boolean,
  onboardingCompleted: boolean,
): 'stripe' | 'hubspot' | 'first_win' | 'done' {
  if (!stripeConnected) return 'stripe'
  if (!hubspotConnected && !onboardingCompleted) return 'hubspot'
  if (!firstWinSeen) return 'first_win'
  return 'done'
}

type PatchField = 'first_win_seen' | 'onboarding_completed'

function validatePatchBody(body: unknown): { valid: boolean; error?: string; field?: PatchField } {
  if (typeof body !== 'object' || body === null) return { valid: false, error: 'Invalid JSON body' }
  const b = body as Record<string, unknown>
  if (b.value !== true) return { valid: false, error: 'value must be true' }
  if (b.field !== 'first_win_seen' && b.field !== 'onboarding_completed') {
    return { valid: false, error: 'Invalid field. Must be first_win_seen or onboarding_completed' }
  }
  return { valid: true, field: b.field as PatchField }
}

// ── Tests determineCurrentStep ────────────────────────────────

describe('onboarding-status: determineCurrentStep', () => {
  it("retourne 'stripe' quand Stripe n'est pas connecté", () => {
    expect(determineCurrentStep(false, false, false, false)).toBe('stripe')
  })

  it("retourne 'stripe' même si hubspot connecté et first_win vu (stripe absent = bloquant)", () => {
    expect(determineCurrentStep(false, true, true, false)).toBe('stripe')
  })

  it("retourne 'hubspot' quand Stripe connecté mais pas HubSpot et onboarding non complété", () => {
    expect(determineCurrentStep(true, false, false, false)).toBe('hubspot')
  })

  it("retourne 'hubspot' si Stripe connecté, HubSpot absent, first_win déjà vu mais onboarding non complété", () => {
    expect(determineCurrentStep(true, false, true, false)).toBe('hubspot')
  })

  it("retourne 'first_win' quand Stripe connecté + HubSpot connecté + first_win pas encore vu", () => {
    expect(determineCurrentStep(true, true, false, false)).toBe('first_win')
  })

  it("retourne 'first_win' quand Stripe connecté + onboarding_completed=true (skip HubSpot) + first_win pas encore vu", () => {
    expect(determineCurrentStep(true, false, false, true)).toBe('first_win')
  })

  it("retourne 'done' quand tout est complété (stripe + hubspot + first_win vu)", () => {
    expect(determineCurrentStep(true, true, true, false)).toBe('done')
  })

  it("retourne 'done' quand stripe + onboarding_completed=true + first_win vu", () => {
    expect(determineCurrentStep(true, false, true, true)).toBe('done')
  })

  it("retourne 'done' quand onboarding_completed=true et first_win_seen=true", () => {
    expect(determineCurrentStep(true, true, true, true)).toBe('done')
  })
})

// ── Tests validation PATCH body ───────────────────────────────

describe('onboarding-status: validation PATCH body', () => {
  it("accepte { field: 'first_win_seen', value: true }", () => {
    const result = validatePatchBody({ field: 'first_win_seen', value: true })
    expect(result.valid).toBe(true)
    expect(result.field).toBe('first_win_seen')
  })

  it("accepte { field: 'onboarding_completed', value: true }", () => {
    const result = validatePatchBody({ field: 'onboarding_completed', value: true })
    expect(result.valid).toBe(true)
    expect(result.field).toBe('onboarding_completed')
  })

  it('rejette si value !== true (false)', () => {
    const result = validatePatchBody({ field: 'first_win_seen', value: false })
    expect(result.valid).toBe(false)
    expect(result.error).toBe('value must be true')
  })

  it('rejette si value est une string "true" et non un booléen', () => {
    const result = validatePatchBody({ field: 'first_win_seen', value: 'true' })
    expect(result.valid).toBe(false)
    expect(result.error).toBe('value must be true')
  })

  it("rejette si field est une valeur inconnue", () => {
    const result = validatePatchBody({ field: 'unknown_field', value: true })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Invalid field')
  })

  it('rejette si le body est null', () => {
    const result = validatePatchBody(null)
    expect(result.valid).toBe(false)
  })

  it('rejette si le body est une string', () => {
    const result = validatePatchBody('not an object')
    expect(result.valid).toBe(false)
  })

  it("rejette si field est absent mais value=true", () => {
    const result = validatePatchBody({ value: true })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Invalid field')
  })
})
