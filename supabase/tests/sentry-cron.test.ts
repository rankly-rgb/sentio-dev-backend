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

    const checkin = startCronCheckin('nightly-sync')
    await expect(checkin.finish('ok')).resolves.toBeUndefined()
    await expect(checkin.finish('error')).resolves.toBeUndefined()

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// Le protocole : UN SEUL pointage, à la fin. Sentry répond 202 sans corps et
// ne rend aucun id (vérifié en direct le 2026-08-17), donc un pointage
// d'ouverture créerait un check-in impossible à refermer — il resterait
// ouvert jusqu'au timeout du monitor, soit une fausse alerte sur chaque
// exécution pourtant réussie.
describe('startCronCheckin — protocole à un seul pointage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete denoEnv.SENTRY_DSN
    delete denoEnv.SENTRY_CRON_URL_NIGHTLY_SYNC
  })

  it('n’émet rien avant finish, puis exactement une requête', async () => {
    denoEnv.SENTRY_DSN = DSN
    const calls: Array<{ url: string; method: string; body: string }> = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      calls.push({ url: String(url), method: String(init?.method), body: String(init?.body) })
      return Promise.resolve(new Response('', { status: 202 }))
    })

    const checkin = startCronCheckin('nightly-sync')
    expect(fetchSpy).not.toHaveBeenCalled()

    await checkin.finish('ok')

    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(JSON.parse(calls[0].body)).toEqual({ status: 'ok' })
    // Pas d'id dans l'URL : le pointage vise le monitor, pas un check-in.
    expect(calls[0].url).toBe(
      'https://o4511921139089408.ingest.de.sentry.io/api/4511921266688080/cron/nightly-sync/74b089d54017f6ad6bcfb4da6122f687/',
    )
  })

  it('transmet le statut error tel quel', async () => {
    denoEnv.SENTRY_DSN = DSN
    let body = ''
    vi.spyOn(globalThis, 'fetch').mockImplementation((_u, init) => {
      body = String(init?.body)
      return Promise.resolve(new Response('', { status: 202 }))
    })

    await startCronCheckin('nightly-sync').finish('error')

    expect(JSON.parse(body)).toEqual({ status: 'error' })
  })

  // 202 sans corps est la réponse NORMALE de Sentry — surtout pas un warn.
  it('accepte un 202 au corps vide sans rien signaler', async () => {
    denoEnv.SENTRY_DSN = DSN
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }))

    await startCronCheckin('nightly-sync').finish('ok')

    expect(warn).not.toHaveBeenCalled()
  })

  it('signale un pointage rejeté', async () => {
    denoEnv.SENTRY_DSN = DSN
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('monitor not found', { status: 404 }))

    await startCronCheckin('nightly-sync').finish('ok')

    const logged = JSON.parse(warn.mock.calls[0][0] as string)
    expect(logged.message).toBe('pointage rejeté par Sentry')
    expect(logged.status).toBe(404)
    expect(logged.body).toBe('monitor not found')
  })

  it('survit à un fetch qui rejette', async () => {
    denoEnv.SENTRY_DSN = DSN
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connexion refusée'))

    await expect(startCronCheckin('nightly-sync').finish('ok')).resolves.toBeUndefined()
  })

  it('survit à un fetch qui lève de façon synchrone', async () => {
    denoEnv.SENTRY_DSN = DSN
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new TypeError('échec synchrone inattendu')
    })

    await expect(startCronCheckin('nightly-sync').finish('ok')).resolves.toBeUndefined()
  })

  it('survit à un environnement qui lève sur env.get', async () => {
    const denoRef = (globalThis as unknown as { Deno: { env: { get: (k: string) => string | undefined } } }).Deno
    const original = denoRef.env.get
    vi.spyOn(console, 'error').mockImplementation(() => {})
    denoRef.env.get = () => { throw new Error('accès environnement refusé') }
    try {
      const checkin = startCronCheckin('nightly-sync')
      await expect(checkin.finish('ok')).resolves.toBeUndefined()
    } finally {
      denoRef.env.get = original
    }
  })

  it('ne pointe qu’une fois, même appelé deux fois', async () => {
    denoEnv.SENTRY_DSN = DSN
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }))

    const checkin = startCronCheckin('nightly-sync')
    await checkin.finish('ok')
    await checkin.finish('error')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
