import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleUpdateStripeConnection } from '../functions/update-stripe-connection/index.ts'
import { handleVerifyStripeToken } from '../functions/verify-stripe-token/index.ts'

// ── Preuve de bout en bout (2026-08-20 suite) — comble le trou de la
// Phase 3 précédente : une preuve SQL directe contre la DB de dev ne
// prouve pas que le code applicatif (parsing de requête, lecture de
// Deno.env.get('ALLOW_SHARED_STRIPE_KEY'), construction de la réponse
// HTTP) se comporte comme prévu.
//
// Ce fichier invoque le VRAI handler HTTP — update-stripe-connection/
// index.ts::handleUpdateStripeConnection et verify-stripe-token/
// index.ts::handleVerifyStripeToken, tous deux fraîchement exportés
// (extraction mécanique, même convention que accounts-api::handleGetOne)
// — avec un client Supabase et un client Stripe entièrement mockés, mais
// SANS dupliquer la logique de décision : c'est le code réel qui tourne,
// import réel (pas une copie miroir).
//
// Ce qui reste hors de portée de ce test, faute d'accès réseau sortant
// dans cet environnement : un vrai `supabase functions serve` local +
// une vraie requête HTTP localhost contre l'API Stripe réelle. Ce fichier
// exerce donc le handler "en mémoire" (fetch(Request) → Response), pas un
// aller-retour TCP — la couche HTTP elle-même (routing Deno.serve,
// framing) reste couverte seulement par la conviction que Deno.serve()
// est un simple passe-plat vers la fonction exportée (vrai par lecture du
// code, jamais exercé littéralement ici).

const state = vi.hoisted(() => ({ supabase: null as unknown }))

vi.mock('../functions/_shared/supabase-client.ts', () => ({
  createServiceClient: () => state.supabase,
  jsonResponse: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }),
  errorResponse: (message: string, status = 400) =>
    new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } }),
}))

vi.mock('../functions/_shared/auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../functions/_shared/auth.ts')>()
  return {
    ...actual,
    // Le token porté par Authorization: Bearer <token> EST directement
    // l'organization_id pour ce test — évite de simuler un vrai JWT ES256,
    // seule la décision applicative post-auth nous intéresse ici.
    verifyUserAuth: async (req: Request) => {
      const authHeader = req.headers.get('Authorization') ?? ''
      const token = authHeader.replace('Bearer ', '')
      if (!token) throw new actual.AuthError('Missing or invalid Authorization header', 401)
      return { userId: 'test-user', organizationId: token }
    },
  }
})

vi.mock('../functions/_shared/fetch-with-timeout.ts', () => ({
  // Simule "la même clé Stripe partagée" : /v1/account répond toujours le
  // même compte, quelle que soit l'org appelante — c'est exactement le
  // scénario que la mission décrit (clé test-mode réutilisée).
  fetchWithTimeout: async (url: string) => {
    if (url.includes('/v1/account')) {
      return new Response(JSON.stringify({ id: 'acct_shared_test' }), { status: 200 })
    }
    return new Response(null, { status: 200 })
  },
}))

interface OrgRow {
  id: string
  stripe_account_id?: string | null
  stripe_api_key?: string | null
  stripe_connected?: boolean
  stripe_connection_method?: string | null
  onboarding_step?: string
}

function orgSelectChain(orgs: Map<string, OrgRow>) {
  const filters: Array<['eq' | 'neq', string, unknown]> = []
  // deno-lint-ignore no-explicit-any
  const chain: any = {
    select: () => chain,
    eq: (col: string, val: unknown) => { filters.push(['eq', col, val]); return chain },
    neq: (col: string, val: unknown) => { filters.push(['neq', col, val]); return chain },
    limit: () => chain,
    maybeSingle: async () => {
      const rows = [...orgs.values()].filter((o) =>
        filters.every(([type, col, val]) => (type === 'eq' ? (o as Record<string, unknown>)[col] === val : (o as Record<string, unknown>)[col] !== val)),
      )
      return { data: rows[0] ? { id: rows[0].id } : null, error: null }
    },
  }
  return chain
}

function orgUpdateChain(orgs: Map<string, OrgRow>, patch: Record<string, unknown>) {
  let targetId: string | null = null
  // deno-lint-ignore no-explicit-any
  const chain: any = {
    eq: (col: string, val: string) => { if (col === 'id') targetId = val; return chain },
    in: () => chain,
    then: (resolve: (v: { error: null }) => void) => {
      if (targetId && orgs.has(targetId)) Object.assign(orgs.get(targetId) as OrgRow, patch)
      resolve({ error: null })
    },
  }
  return chain
}

function makeSupabaseStub(orgs: Map<string, OrgRow>) {
  return {
    from(table: string) {
      if (table === 'organizations') {
        return {
          select: () => orgSelectChain(orgs),
          update: (patch: Record<string, unknown>) => orgUpdateChain(orgs, patch),
        }
      }
      if (table === 'organization_integrations') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            }),
          }),
          upsert: async () => ({ error: null }),
        }
      }
      throw new Error(`stub: unexpected table ${table}`)
    },
    rpc: async (name: string) => {
      if (name === 'vault_create_secret') return { data: 'secret-uuid-123', error: null }
      return { error: null }
    },
  }
}

const denoEnv = (globalThis as unknown as { __DENO_ENV__: Record<string, string | undefined> }).__DENO_ENV__

beforeEach(() => {
  delete denoEnv.ALLOW_SHARED_STRIPE_KEY
})

afterEach(() => {
  delete denoEnv.ALLOW_SHARED_STRIPE_KEY
})

const SHARED_KEY = `sk_test_${'0'.repeat(24)}`

function updateConnectionRequest(orgId: string, apiKey = SHARED_KEY): Request {
  return new Request('http://localhost/update-stripe-connection', {
    method: 'POST',
    headers: { Authorization: `Bearer ${orgId}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update', stripe_api_key: apiKey }),
  })
}

function verifyTokenRequest(orgId: string, apiKey = SHARED_KEY): Request {
  return new Request('http://localhost/verify-stripe-token', {
    method: 'POST',
    headers: { Authorization: `Bearer ${orgId}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ stripe_api_key: apiKey }),
  })
}

describe('handleUpdateStripeConnection — real handler, shared Stripe key across orgs', () => {
  it('org A (first claimant) connects successfully and holds stripe_account_id', async () => {
    const orgs = new Map<string, OrgRow>([['org-a', { id: 'org-a' }]])
    state.supabase = makeSupabaseStub(orgs)

    const res = await handleUpdateStripeConnection(updateConnectionRequest('org-a'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ success: true, account_id: 'acct_shared_test' })
    expect(orgs.get('org-a')?.stripe_account_id).toBe('acct_shared_test')
    expect(orgs.get('org-a')?.stripe_api_key).toBe(SHARED_KEY)
  })

  it('DEFAULT BEHAVIOR (flag absent — real beta cohort): org B connecting the same key still gets 409, exactly as before this mission', async () => {
    const orgs = new Map<string, OrgRow>([
      ['org-a', { id: 'org-a', stripe_account_id: 'acct_shared_test' }],
      ['org-b', { id: 'org-b' }],
    ])
    state.supabase = makeSupabaseStub(orgs)

    // ALLOW_SHARED_STRIPE_KEY intentionally left unset — this is the
    // production default every real beta user goes through.
    const res = await handleUpdateStripeConnection(updateConnectionRequest('org-b'))
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error).toContain('already connected to another organization')
    // Rien n'a été écrit pour org-b : un refus ne doit laisser aucun état partiel.
    expect(orgs.get('org-b')?.stripe_api_key).toBeUndefined()
    expect(orgs.get('org-b')?.stripe_account_id).toBeUndefined()
  })

  it('ALLOW_SHARED_STRIPE_KEY=true: org B connecting the same key now succeeds, stripe_account_id left unset for org B', async () => {
    const orgs = new Map<string, OrgRow>([
      ['org-a', { id: 'org-a', stripe_account_id: 'acct_shared_test' }],
      ['org-b', { id: 'org-b' }],
    ])
    state.supabase = makeSupabaseStub(orgs)
    denoEnv.ALLOW_SHARED_STRIPE_KEY = 'true'

    const res = await handleUpdateStripeConnection(updateConnectionRequest('org-b'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ success: true, account_id: 'acct_shared_test' })
    // La clé EST partagée...
    expect(orgs.get('org-b')?.stripe_api_key).toBe(SHARED_KEY)
    // ...mais stripe_account_id N'EST PAS écrasé/dupliqué : la contrainte
    // UNIQUE reste intacte, on la contourne en ne l'écrivant pas.
    expect(orgs.get('org-b')?.stripe_account_id).toBeUndefined()
    expect(orgs.get('org-a')?.stripe_account_id).toBe('acct_shared_test')
    // sync-stripe eligibility: org B is now eligible (stripe_api_key set, stripe_connected true).
    expect(orgs.get('org-b')?.stripe_connected).toBe(true)
  })

  it('ALLOW_SHARED_STRIPE_KEY=true but NO conflict exists: behaves exactly like the flag was off (bypass only engages on an actual conflict)', async () => {
    const orgs = new Map<string, OrgRow>([['org-solo', { id: 'org-solo' }]])
    state.supabase = makeSupabaseStub(orgs)
    denoEnv.ALLOW_SHARED_STRIPE_KEY = 'true'

    const res = await handleUpdateStripeConnection(updateConnectionRequest('org-solo'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(orgs.get('org-solo')?.stripe_account_id).toBe('acct_shared_test')
  })
})

describe('handleVerifyStripeToken — real handler, the onboarding path that never had a uniqueness guard', () => {
  it('org A connects via the real /signup onboarding path — succeeds, never touches stripe_account_id', async () => {
    const orgs = new Map<string, OrgRow>([['org-a', { id: 'org-a' }]])
    state.supabase = makeSupabaseStub(orgs)

    const res = await handleVerifyStripeToken(verifyTokenRequest('org-a'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ success: true })
    expect(orgs.get('org-a')?.stripe_api_key).toBe(SHARED_KEY)
    expect(orgs.get('org-a')?.stripe_account_id).toBeUndefined()
  })

  it('UNCHANGED BEHAVIOR: org B connecting the identical key via the same onboarding path ALSO succeeds, flag absent — this path was never gated, before or after this mission', async () => {
    const orgs = new Map<string, OrgRow>([
      ['org-a', { id: 'org-a', stripe_api_key: SHARED_KEY, stripe_connected: true }],
      ['org-b', { id: 'org-b' }],
    ])
    state.supabase = makeSupabaseStub(orgs)
    // ALLOW_SHARED_STRIPE_KEY intentionally left unset.

    const res = await handleVerifyStripeToken(verifyTokenRequest('org-b'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ success: true })
    expect(orgs.get('org-b')?.stripe_api_key).toBe(SHARED_KEY)
    expect(orgs.get('org-a')?.stripe_api_key).toBe(orgs.get('org-b')?.stripe_api_key)
  })

  it('the flag has zero effect on this path either way — proves nothing changed here for real beta users', async () => {
    const orgsFlagOff = new Map<string, OrgRow>([['org-x', { id: 'org-x' }]])
    state.supabase = makeSupabaseStub(orgsFlagOff)
    const resOff = await handleVerifyStripeToken(verifyTokenRequest('org-x'))

    const orgsFlagOn = new Map<string, OrgRow>([['org-y', { id: 'org-y' }]])
    state.supabase = makeSupabaseStub(orgsFlagOn)
    denoEnv.ALLOW_SHARED_STRIPE_KEY = 'true'
    const resOn = await handleVerifyStripeToken(verifyTokenRequest('org-y'))

    expect(resOff.status).toBe(resOn.status)
    expect((await resOff.json()).success).toBe((await resOn.json()).success)
  })
})
