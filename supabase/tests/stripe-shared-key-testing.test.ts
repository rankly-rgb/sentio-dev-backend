import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  isSharedStripeKeyTestingAllowed,
  logSharedStripeKeyIfDetected,
} from '../functions/_shared/stripe-shared-key-testing.ts'

// Import réel (pas de copie miroir) — zéro dépendance Deno-native au
// runtime, même convention que stripe-account-claim.ts /
// update-stripe-connection.test.ts.

describe('isSharedStripeKeyTestingAllowed', () => {
  // `Deno.env` sous Vitest est un shim en lecture (supabase/tests/setup/
  // deno-shim.ts) — les valeurs se posent via globalThis.__DENO_ENV__,
  // même convention que sentry-cron.test.ts.
  const denoEnv = (globalThis as unknown as { __DENO_ENV__: Record<string, string | undefined> }).__DENO_ENV__

  afterEach(() => {
    delete denoEnv.ALLOW_SHARED_STRIPE_KEY
  })

  it('is false when the env var is absent (default — real beta cohort)', () => {
    delete denoEnv.ALLOW_SHARED_STRIPE_KEY
    expect(isSharedStripeKeyTestingAllowed()).toBe(false)
  })

  it('is false for any value other than the literal string "true"', () => {
    denoEnv.ALLOW_SHARED_STRIPE_KEY = '1'
    expect(isSharedStripeKeyTestingAllowed()).toBe(false)
    denoEnv.ALLOW_SHARED_STRIPE_KEY = 'TRUE'
    expect(isSharedStripeKeyTestingAllowed()).toBe(false)
    denoEnv.ALLOW_SHARED_STRIPE_KEY = 'false'
    expect(isSharedStripeKeyTestingAllowed()).toBe(false)
  })

  it('is true only when explicitly set to "true"', () => {
    denoEnv.ALLOW_SHARED_STRIPE_KEY = 'true'
    expect(isSharedStripeKeyTestingAllowed()).toBe(true)
  })
})

describe('logSharedStripeKeyIfDetected', () => {
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

  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('logs a warn with both org ids when another org shares the same key', async () => {
    const { client, calls } = stubClient({ data: { id: 'other-org' }, error: null })
    await logSharedStripeKeyIfDetected(client, 'my-org', 'sk_test_shared', 'verify-stripe-token')

    expect(calls.table).toBe('organizations')
    expect(calls['eq:stripe_api_key']).toBe('sk_test_shared')
    // Le .neq est ce qui évite de se signaler soi-même en cas de re-connexion.
    expect(calls['neq:id']).toBe('my-org')

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string)
    expect(logged.event).toBe('shared_stripe_key_detected')
    expect(logged.test_mode_only).toBe(true)
    expect(logged.organization_id).toBe('my-org')
    expect(logged.other_organization_id).toBe('other-org')
    expect(logged.function_name).toBe('verify-stripe-token')
  })

  it('logs nothing when no other org holds the key', async () => {
    const { client } = stubClient({ data: null, error: null })
    await logSharedStripeKeyIfDetected(client, 'my-org', 'sk_test_unique', 'update-stripe-connection')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('never throws when the lookup itself fails — logs an error, not a warn', async () => {
    const { client } = stubClient({ data: null, error: { message: 'connection reset' } })
    await expect(
      logSharedStripeKeyIfDetected(client, 'my-org', 'sk_test_x', 'update-stripe-connection'),
    ).resolves.toBeUndefined()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('never throws when the client itself throws synchronously', async () => {
    // deno-lint-ignore no-explicit-any
    const throwingClient = { from: () => { throw new Error('boom') } } as any
    await expect(
      logSharedStripeKeyIfDetected(throwingClient, 'my-org', 'sk_test_x', 'update-stripe-connection'),
    ).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })
})
