// ============================================================
// Sentry Cron Monitors — pointage des jobs planifiés
// (Pièce 3 de l'infrastructure de fin de chantier, volet crons)
// ============================================================
//
// Principe, et c'est tout l'intérêt : le cron « pointe » auprès de Sentry au
// début et à la fin de chaque exécution. Si le pointage n'arrive pas à
// l'heure prévue, **l'absence elle-même** déclenche l'alerte. C'est la
// différence avec `self-monitor`, qui ne pouvait rien signaler quand il ne
// tournait pas lui-même — il n'a d'ailleurs pas tourné pendant cinq mois
// sans que personne le sache (issue #38).
//
// URL de pointage : dérivée du `SENTRY_DSN` déjà configuré, pas d'un secret
// supplémentaire à poser et à garder synchronisé. Un DSN a la forme
// `https://<clé_publique>@<hôte>/<id_projet>` et l'API de check-in vit à
// `https://<hôte>/api/<id_projet>/cron/<slug>/<clé_publique>/` — tout est
// donc déjà là. Échappatoire si Sentry change ce format : poser
// `SENTRY_CRON_URL_<SLUG>` (slug en majuscules, tirets → underscores,
// ex. `SENTRY_CRON_URL_NIGHTLY_SYNC`) qui prime sur la dérivation.
//
// Le check-in terminal réutilise l'`id` renvoyé par le check-in initial.
// Sans cet id, Sentry créerait deux check-ins indépendants : le premier
// resterait `in_progress` pour toujours et finirait marqué en timeout —
// une alerte fausse à chaque exécution pourtant réussie.
//
// Rien ici ne peut faire échouer un cron : aucune fonction ne lève, et
// l'absence de DSN rend l'ensemble silencieusement inerte.

import { fetchWithTimeout } from './fetch-with-timeout.ts'

const CHECKIN_TIMEOUT_MS = 5_000

/**
 * Construit l'URL de check-in à partir d'un DSN Sentry.
 *
 * Retourne `null` — jamais une URL approximative — si le DSN est absent ou
 * ne correspond pas à la forme attendue : mieux vaut ne pas pointer du tout
 * (le monitor signale l'absence) que pointer dans le vide en croyant que
 * la surveillance est en place.
 */
export function buildCheckinUrl(dsn: string | undefined, monitorSlug: string): string | null {
  if (!dsn || !monitorSlug) return null

  let parsed: URL
  try {
    parsed = new URL(dsn)
  } catch {
    return null
  }

  const publicKey = parsed.username
  const projectId = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!publicKey || !projectId) return null

  return `${parsed.protocol}//${parsed.host}/api/${projectId}/cron/${monitorSlug}/${publicKey}/`
}

/** Nom de la variable d'environnement qui prime sur la dérivation, pour un slug donné. */
export function overrideEnvName(monitorSlug: string): string {
  return `SENTRY_CRON_URL_${monitorSlug.toUpperCase().replace(/-/g, '_')}`
}

function resolveCheckinUrl(monitorSlug: string): string | null {
  const override = Deno.env.get(overrideEnvName(monitorSlug))
  if (override) return override.endsWith('/') ? override : `${override}/`
  return buildCheckinUrl(Deno.env.get('SENTRY_DSN'), monitorSlug)
}

export interface CronCheckin {
  /** Clôture le pointage. Idempotent, ne lève jamais, no-op si le départ n'a pas abouti. */
  finish(status: 'ok' | 'error'): Promise<void>
}

const NOOP_CHECKIN: CronCheckin = { finish: () => Promise.resolve() }

/**
 * Ouvre un pointage `in_progress` et retourne de quoi le clôturer.
 *
 * Retourne toujours un objet utilisable : sans DSN, ou si Sentry est
 * injoignable, `finish()` ne fait rien. Un cron ne doit jamais échouer
 * parce que sa surveillance est en panne.
 */
export async function startCronCheckin(monitorSlug: string): Promise<CronCheckin> {
  // Try/catch englobant, volontairement redondant avec celui du fetch plus bas.
  // L'invariant annoncé par ce module — « rien ici ne peut faire échouer un
  // cron » — était garanti seulement pour l'appel réseau, pas pour la
  // résolution d'URL ni pour ce que l'environnement d'exécution peut faire
  // remonter d'inattendu. Un 500 sur sync-stripe le 2026-08-16 a montré que
  // l'invariant se prouve mal par relecture : il est désormais posé à la
  // frontière du module, où il ne dépend plus du détail de ce qu'il enveloppe.
  try {
    return await openCheckin(monitorSlug)
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'sentry-cron',
      message: 'startCronCheckin a levé — pointage abandonné, le cron continue',
      monitor: monitorSlug,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }))
    return NOOP_CHECKIN
  }
}

async function openCheckin(monitorSlug: string): Promise<CronCheckin> {
  const baseUrl = resolveCheckinUrl(monitorSlug)
  if (!baseUrl) return NOOP_CHECKIN

  let checkinId: string | null = null
  try {
    const resp = await fetchWithTimeout(
      baseUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'in_progress' }),
      },
      CHECKIN_TIMEOUT_MS,
    )
    if (resp.ok) {
      const payload = await resp.json().catch(() => null)
      const id = (payload as { id?: unknown } | null)?.id
      if (typeof id === 'string' && id.length > 0) checkinId = id
    } else {
      console.warn(JSON.stringify({
        level: 'warn',
        function_name: 'sentry-cron',
        message: 'check-in in_progress rejeté',
        monitor: monitorSlug,
        status: resp.status,
      }))
    }
  } catch (err) {
    console.warn(JSON.stringify({
      level: 'warn',
      function_name: 'sentry-cron',
      message: 'check-in in_progress injoignable',
      monitor: monitorSlug,
      error: err instanceof Error ? err.message : String(err),
    }))
  }

  // Sans id, on ne clôture pas : un `?status=ok` isolé ouvrirait un
  // deuxième check-in sans fermer le premier — pire que ne rien envoyer.
  if (!checkinId) return NOOP_CHECKIN

  let done = false
  return {
    async finish(status: 'ok' | 'error'): Promise<void> {
      if (done) return
      done = true
      try {
        await fetchWithTimeout(
          `${baseUrl}${checkinId}/`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status }),
          },
          CHECKIN_TIMEOUT_MS,
        )
      } catch (err) {
        console.warn(JSON.stringify({
          level: 'warn',
          function_name: 'sentry-cron',
          message: 'check-in terminal injoignable',
          monitor: monitorSlug,
          error: err instanceof Error ? err.message : String(err),
        }))
      }
    },
  }
}
