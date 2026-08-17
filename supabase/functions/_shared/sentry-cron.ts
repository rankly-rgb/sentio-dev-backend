// ============================================================
// Sentry Cron Monitors — pointage des jobs planifiés
// (Pièce 3 de l'infrastructure de fin de chantier, volet crons)
// ============================================================
//
// Principe, et c'est tout l'intérêt : le cron « pointe » auprès de Sentry en
// fin d'exécution. Si le pointage n'arrive pas à l'heure prévue,
// **l'absence elle-même** déclenche l'alerte. C'est la
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
// UN SEUL pointage, à la fin — pas d'`in_progress`. Vérifié en direct le
// 2026-08-17 : l'API de check-in répond `202` avec un **corps vide**, elle ne
// rend aucun `id`. Un pointage d'ouverture crée donc un check-in que rien ne
// peut ensuite refermer : il reste ouvert jusqu'au timeout du monitor, ce qui
// produit une fausse alerte à chaque exécution pourtant réussie (constaté sur
// `nightly-sync`, check-in `1226c5a4`, marqué « Timed Out » sur un run de 18
// secondes qui s'était parfaitement déroulé).
//
// Ce que ça coûte : Sentry ne voit plus un run « en cours », donc plus de
// détection de dépassement de durée (`max_runtime`).
// Ce que ça préserve — l'essentiel, et la raison d'être de la pièce : un run
// planifié qui n'arrive pas à l'heure prévue reste détecté, puisque c'est
// l'ABSENCE de pointage qui alerte. Un run qui meurt en cours de route
// n'envoie rien et devient un « missed », ce qui est plus juste qu'un
// check-in ouvert indéfiniment.
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
  /** Envoie l'unique pointage. Idempotent, ne lève jamais. */
  finish(status: 'ok' | 'error'): Promise<void>
}

const NOOP_CHECKIN: CronCheckin = { finish: () => Promise.resolve() }

/**
 * Prépare le pointage d'un run planifié. **N'émet aucune requête** — voir
 * l'en-tête du fichier : Sentry ne rend pas d'id, donc un pointage
 * d'ouverture serait un check-in impossible à refermer.
 *
 * Retourne toujours un objet utilisable : sans DSN, ou si Sentry est
 * injoignable au moment du `finish`, rien ne remonte à l'appelant. Un cron
 * ne doit jamais échouer parce que sa surveillance est en panne.
 */
export function startCronCheckin(monitorSlug: string): CronCheckin {
  let baseUrl: string | null = null
  try {
    baseUrl = resolveCheckinUrl(monitorSlug)
  } catch (err) {
    // La résolution d'URL ne devrait pas lever, mais l'invariant « rien ici
    // ne peut faire échouer un cron » se prouve mal par relecture : un 500
    // sur sync-stripe le 2026-08-16 l'a montré. Garde posée à la frontière.
    console.error(JSON.stringify({
      level: 'error',
      function_name: 'sentry-cron',
      message: 'résolution de l\'URL de pointage impossible — pointage abandonné, le cron continue',
      monitor: monitorSlug,
      error: err instanceof Error ? err.message : String(err),
    }))
    return NOOP_CHECKIN
  }
  if (!baseUrl) return NOOP_CHECKIN

  const url = baseUrl
  let done = false
  return {
    async finish(status: 'ok' | 'error'): Promise<void> {
      if (done) return
      done = true
      try {
        const resp = await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status }),
          },
          CHECKIN_TIMEOUT_MS,
        )
        // Un pointage rejeté est un run que Sentry comptera comme manquant.
        // Jamais silencieux : c'est ce silence-là qui a coûté trois tours de
        // diagnostic les 16 et 17 août.
        if (!resp.ok) {
          console.warn(JSON.stringify({
            level: 'warn',
            function_name: 'sentry-cron',
            message: 'pointage rejeté par Sentry',
            monitor: monitorSlug,
            status: resp.status,
            body: (await resp.text().catch(() => '')).slice(0, 200),
          }))
        }
      } catch (err) {
        console.warn(JSON.stringify({
          level: 'warn',
          function_name: 'sentry-cron',
          message: 'pointage injoignable',
          monitor: monitorSlug,
          error: err instanceof Error ? err.message : String(err),
        }))
      }
    },
  }
}
