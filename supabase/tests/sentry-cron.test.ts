import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildCheckinUrl, overrideEnvName, startCronCheckin } from '../functions/_shared/sentry-cron.ts'

// DSN de forme réelle (celui du projet Sentry `sentio-edge`, région de).
const DSN = 'https://74b089d54017f6ad6bcfb4da6122f687@o4511921139089408.ingest.de.sentry.io/4511921266688080'

describe('buildCheckinUrl', () => {
  it('dérive l’URL de check-in depuis un DSN réel', () => {
    expect(buildCheckinUrl(DSN, 'nightly-sync')).toBe(
      'https://o4511921139089408.ingest.de.sentry.io/api/4511921266688080/cron/nightly-sync/74b089d54017f6ad6bcfb4da6122f687/',
    )
  })

  it('gère un DSN sans région (host us par défaut)', () => {
    expect(buildCheckinUrl('https://abc123@o42.ingest.sentry.io/7', 'nightly-scoring')).toBe(
      'https://o42.ingest.sentry.io/api/7/cron/nightly-scoring/abc123/',
    )
  })

  // S1 « no data ≠ neutral data » appliqué à une URL : mieux vaut ne pas
  // pointer du tout — le monitor signale alors l'absence — que pointer dans
  // le vide en laissant croire que la surveillance est en place.
  it('retourne null plutôt qu’une URL approximative quand le DSN manque', () => {
    expect(buildCheckinUrl(undefined, 'nightly-sync')).toBeNull()
    expect(buildCheckinUrl('', 'nightly-sync')).toBeNull()
  })

  it('retourne null quand le DSN n’est pas une URL', () => {
    expect(buildCheckinUrl('pas-une-url', 'nightly-sync')).toBeNull()
  })

  it('retourne null quand la clé publique ou l’id de projet manque', () => {
    expect(buildCheckinUrl('https://o42.ingest.sentry.io/7', 'nightly-sync')).toBeNull()
    expect(buildCheckinUrl('https://abc123@o42.ingest.sentry.io/', 'nightly-sync')).toBeNull()
  })

  it('retourne null quand le slug est vide', () => {
    expect(buildCheckinUrl(DSN, '')).toBeNull()
  })
})

describe('overrideEnvName', () => {
  it('construit le nom de variable d’échappement attendu', () => {
    expect(overrideEnvName('nightly-sync')).toBe('SENTRY_CRON_URL_NIGHTLY_SYNC')
    expect(overrideEnvName('nightly-scoring')).toBe('SENTRY_CRON_URL_NIGHTLY_SCORING')
  })
})

const denoEnv = (globalThis as unknown as { __DENO_ENV__: Record<string, string | undefined> }).__DENO_ENV__

describe('startCronCheckin sans DSN', () => {
  afterEach(() => vi.restoreAllMocks())

  // Sans override, le shim Deno renvoie undefined : ce test décrit donc
  // exactement le cas « SENTRY_DSN non configuré ».
  it('n’émet aucune requête et rend un finish inoffensif', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const checkin = await startCronCheckin('nightly-sync')
    await expect(checkin.finish('ok')).resolves.toBeUndefined()
    await expect(checkin.finish('error')).resolves.toBeUndefined()

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// L'invariant central de ce module : un cron ne doit jamais échouer parce que
// sa surveillance échoue. Il était affirmé par relecture ; un 500 sur
// sync-stripe le 2026-08-16 a montré que ça ne suffit pas. Ces tests
// l'exercent au lieu de le supposer.
describe('startCronCheckin ne laisse jamais rien s’échapper', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete denoEnv.SENTRY_DSN
    delete denoEnv.SENTRY_CRON_URL_NIGHTLY_SYNC
  })

  it('survit à un fetch qui rejette', async () => {
    denoEnv.SENTRY_DSN = DSN
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connexion refusée'))

    const checkin = await startCronCheckin('nightly-sync')
    await expect(checkin.finish('ok')).resolves.toBeUndefined()
  })

  it('survit à un fetch qui lève de façon synchrone', async () => {
    denoEnv.SENTRY_DSN = DSN
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new TypeError('échec synchrone inattendu')
    })

    await expect(startCronCheckin('nightly-sync')).resolves.toBeDefined()
  })

  it('survit à une réponse 404 (monitor absent côté Sentry)', async () => {
    denoEnv.SENTRY_DSN = DSN
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }))

    const checkin = await startCronCheckin('nightly-sync')
    // Pas d'id → pas de pointage terminal, plutôt qu'un second check-in orphelin.
    await expect(checkin.finish('ok')).resolves.toBeUndefined()
  })

  it('survit à un corps de réponse illisible', async () => {
    denoEnv.SENTRY_DSN = DSN
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('pas du json', { status: 200 }))

    const checkin = await startCronCheckin('nightly-sync')
    await expect(checkin.finish('ok')).resolves.toBeUndefined()
  })

  it('survit à un environnement qui lève sur env.get', async () => {
    const denoRef = (globalThis as unknown as { Deno: { env: { get: (k: string) => string | undefined } } }).Deno
    const original = denoRef.env.get
    denoRef.env.get = () => { throw new Error('accès environnement refusé') }
    try {
      await expect(startCronCheckin('nightly-sync')).resolves.toBeDefined()
    } finally {
      denoRef.env.get = original
    }
  })

  it('boucle complète quand tout se passe bien : POST puis PUT sur le même id', async () => {
    denoEnv.SENTRY_DSN = DSN
    const calls: Array<{ url: string; method: string; body: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      calls.push({ url: String(url), method: String(init?.method), body: String(init?.body) })
      return Promise.resolve(new Response(JSON.stringify({ id: 'checkin-abc' }), { status: 200 }))
    })

    const checkin = await startCronCheckin('nightly-sync')
    await checkin.finish('ok')

    expect(calls).toHaveLength(2)
    expect(calls[0].method).toBe('POST')
    expect(JSON.parse(calls[0].body)).toEqual({ status: 'in_progress' })
    expect(calls[1].method).toBe('PUT')
    // Le pointage terminal cible le check-in ouvert, jamais une nouvelle URL.
    expect(calls[1].url).toBe(`${calls[0].url}checkin-abc/`)
    expect(JSON.parse(calls[1].body)).toEqual({ status: 'ok' })
  })

  it('ne clôture qu’une fois, même appelé deux fois', async () => {
    denoEnv.SENTRY_DSN = DSN
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'checkin-abc' }), { status: 200 }),
    )

    const checkin = await startCronCheckin('nightly-sync')
    await checkin.finish('ok')
    await checkin.finish('error')

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
