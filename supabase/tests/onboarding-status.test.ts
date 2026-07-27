import { describe, it, expect } from 'vitest'

// ── Fonctions pures miroir (onboarding-status/index.ts) ───────

type WizardStepStatus = 'completed' | 'active' | 'pending'
interface WizardStep { id: string; label: string; required: boolean; status: WizardStepStatus }

function buildWizardSteps(
  stripeConnected: boolean,
  firstScoreCalculated: boolean,
  ahaMomentSeen: boolean,
  hubspotConnected: boolean,
  onboardingCompleted: boolean,
): WizardStep[] {
  return [
    { id: 'stripe', label: 'Connect Stripe', required: true, status: stripeConnected ? 'completed' : 'active' },
    { id: 'import', label: 'Import data', required: true, status: !stripeConnected ? 'pending' : firstScoreCalculated ? 'completed' : 'active' },
    { id: 'first_win', label: 'First insight', required: true, status: !firstScoreCalculated ? 'pending' : ahaMomentSeen ? 'completed' : 'active' },
    { id: 'hubspot', label: 'Connect HubSpot', required: false, status: hubspotConnected || onboardingCompleted ? 'completed' : !ahaMomentSeen ? 'pending' : 'active' },
  ]
}

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

type PlanTier = 'free' | 'growth' | 'scale' | 'enterprise'

// Chantier D (pricing) — FR-011, cf. onboarding-status/index.ts determineShowCallPrompt
function determineShowCallPrompt(stripeConnected: boolean, planTier: PlanTier): boolean {
  return stripeConnected && (planTier === 'free' || planTier === 'growth')
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

// ── Tests buildWizardSteps ────────────────────────────────────

describe('onboarding-status: buildWizardSteps', () => {
  it('état initial : stripe=active, les 3 autres=pending', () => {
    const steps = buildWizardSteps(false, false, false, false, false)
    expect(steps[0].status).toBe('active')   // stripe
    expect(steps[1].status).toBe('pending')  // import
    expect(steps[2].status).toBe('pending')  // first_win
    expect(steps[3].status).toBe('pending')  // hubspot
  })

  it('stripe connecté, import en cours : stripe=completed, import=active', () => {
    const steps = buildWizardSteps(true, false, false, false, false)
    expect(steps[0].status).toBe('completed')
    expect(steps[1].status).toBe('active')
    expect(steps[2].status).toBe('pending')
    expect(steps[3].status).toBe('pending')
  })

  it('import terminé, aha moment pas encore vu', () => {
    const steps = buildWizardSteps(true, true, false, false, false)
    expect(steps[0].status).toBe('completed')
    expect(steps[1].status).toBe('completed')
    expect(steps[2].status).toBe('active')
    expect(steps[3].status).toBe('pending')
  })

  it('aha moment vu, hubspot non connecté → hubspot=active', () => {
    const steps = buildWizardSteps(true, true, true, false, false)
    expect(steps[2].status).toBe('completed')
    expect(steps[3].status).toBe('active')
  })

  it('tout complété via HubSpot : toutes les étapes=completed', () => {
    const steps = buildWizardSteps(true, true, true, true, true)
    expect(steps.every(s => s.status === 'completed')).toBe(true)
  })

  it('onboarding_completed=true sans HubSpot → hubspot=completed (skip)', () => {
    const steps = buildWizardSteps(true, true, true, false, true)
    expect(steps[3].status).toBe('completed')
  })

  it('stripe est toujours required, hubspot toujours non required', () => {
    const steps = buildWizardSteps(false, false, false, false, false)
    expect(steps.find(s => s.id === 'stripe')?.required).toBe(true)
    expect(steps.find(s => s.id === 'hubspot')?.required).toBe(false)
  })

  it('retourne exactement 4 étapes dans le bon ordre', () => {
    const steps = buildWizardSteps(false, false, false, false, false)
    expect(steps.map(s => s.id)).toEqual(['stripe', 'import', 'first_win', 'hubspot'])
  })
})

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

// ── Tests determineShowCallPrompt (chantier D, T026-T028) ─────

describe('onboarding-status: determineShowCallPrompt', () => {
  it('T026: false before connecting Stripe (customer data), for a Free/Growth organization', () => {
    expect(determineShowCallPrompt(false, 'free')).toBe(false)
    expect(determineShowCallPrompt(false, 'growth')).toBe(false)
  })

  it('T027: true once stripe_connected is true, for Free/Growth — current_step is unaffected by this field', () => {
    expect(determineShowCallPrompt(true, 'free')).toBe(true)
    expect(determineShowCallPrompt(true, 'growth')).toBe(true)
  })

  it('T028: always false for scale/enterprise (appointment already mandatory elsewhere)', () => {
    expect(determineShowCallPrompt(true, 'scale')).toBe(false)
    expect(determineShowCallPrompt(true, 'enterprise')).toBe(false)
    expect(determineShowCallPrompt(false, 'scale')).toBe(false)
    expect(determineShowCallPrompt(false, 'enterprise')).toBe(false)
  })
})
