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

describe('startCronCheckin sans DSN', () => {
  afterEach(() => vi.restoreAllMocks())

  // Le shim Deno des tests renvoie toujours undefined pour env.get : ce test
  // décrit donc exactement le cas « SENTRY_DSN non configuré ».
  it('n’émet aucune requête et rend un finish inoffensif', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const checkin = await startCronCheckin('nightly-sync')
    await expect(checkin.finish('ok')).resolves.toBeUndefined()
    await expect(checkin.finish('error')).resolves.toBeUndefined()

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
