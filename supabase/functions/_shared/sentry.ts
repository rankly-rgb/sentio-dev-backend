// ============================================================
// Sentry — Edge Functions (Pièce 3 de l'infrastructure, volet backend)
// ============================================================
//
// Une seule chose : toute exception non rattrapée d'une Edge Function part
// vers Sentry, avec le nom de la fonction, puis l'appelant reçoit un 500
// propre. Pas de traces de performance, pas de profiling.
//
// `defaultIntegrations: false` est délibéré et important : les intégrations
// par défaut installent des hooks globaux (variables globales, breadcrumbs
// de console) qui, dans un runtime où plusieurs requêtes partagent la même
// isolate, mélangent le contexte d'une requête avec celui d'une autre. On
// perdrait la seule chose qui rend un rapport exploitable — savoir de quelle
// requête il parle.
//
// `Sentry.flush()` avant de répondre n'est pas optionnel : une isolate Edge
// peut être gelée dès la réponse renvoyée, et un événement encore en file
// d'attente serait perdu. C'est exactement le mode de défaillance que cette
// pièce existe pour supprimer — un incident réel, invisible.
//
// Sans `SENTRY_DSN`, tout ce module est un no-op : `withSentry` renvoie le
// handler inchangé, et rien n'est chargé au démarrage de la fonction.

import * as Sentry from 'npm:@sentry/deno@^8'
import { corsHeaders } from './cors.ts'

const DSN = Deno.env.get('SENTRY_DSN')

if (DSN) {
  Sentry.init({
    dsn: DSN,
    defaultIntegrations: false,
    tracesSampleRate: 0,
  })
  const region = Deno.env.get('SB_REGION')
  if (region) Sentry.setTag('region', region)
}

/** True quand un DSN est configuré — sinon `withSentry` ne fait rien. */
export function isSentryEnabled(): boolean {
  return typeof DSN === 'string' && DSN.length > 0
}

type Handler = (req: Request) => Promise<Response> | Response

/**
 * Enveloppe le handler d'une Edge Function.
 *
 * Sans DSN, retourne le handler tel quel — le comportement de la fonction
 * est alors strictement identique à avant l'enrôlement.
 *
 * @param name slug de la fonction, tel qu'il apparaît dans l'URL et dans
 *             `supabase/functions/` — c'est le tag qui permet de répondre à
 *             « quelle fonction casse ? » sans lire la stack.
 */
export function withSentry(name: string, handler: Handler): Handler {
  if (!isSentryEnabled()) return handler

  return async (req: Request): Promise<Response> => {
    try {
      return await handler(req)
    } catch (err) {
      // Loggé AUSSI en local, pas seulement envoyé à Sentry. Sans cette ligne,
      // un 500 produit par ce wrapper ne laisse aucune trace dans les logs
      // Supabase — c'est exactement ce qui a rendu le 500 du 2026-08-16
      // 19:18:25 indiagnosticable sans accès à Sentry. Une erreur ne doit
      // jamais être visible dans un seul endroit.
      console.error(JSON.stringify({
        level: 'error',
        function_name: name,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }))
      Sentry.withScope((scope) => {
        scope.setTag('function', name)
        Sentry.captureException(err)
      })
      // Indispensable : sans ce flush, l'isolate peut être gelée avant que
      // l'événement soit parti.
      await Sentry.flush(2000)

      // La réponse reste volontairement opaque — jamais de stack ni de
      // message interne renvoyé à l'appelant (règle déjà appliquée par
      // `errorResponse` ailleurs dans ce dossier).
      // Les headers CORS sont indispensables : sans eux, un navigateur verrait
      // une erreur CORS opaque au lieu du 500 — l'inverse de l'objectif.
      return new Response(
        JSON.stringify({ error: 'Internal Server Error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }
  }
}
