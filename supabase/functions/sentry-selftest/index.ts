// ============================================================
// Edge Function : sentry-selftest
//
// Lève une exception, toujours. C'est tout ce qu'elle fait.
//
// Raison d'être : la seule preuve acceptable que la chaîne
// « exception Edge → Sentry » fonctionne est un événement réellement reçu
// dans Sentry. Aucune fonction métier ne permet de la produire sans casser
// un endpoint réel — toutes rattrapent leurs erreurs et répondent
// proprement, ce qui est le comportement voulu. D'où cet endpoint dédié :
// il rend la vérification possible aujourd'hui, et rejouable après
// n'importe quel changement futur de `_shared/sentry.ts` ou du DSN.
//
// Ne touche aucune table, ne lit aucun secret, ne prend aucun paramètre.
// `verify_jwt = true` (config.toml) : la plateforme rejette les appels sans
// JWT valide avant même d'atteindre ce code.
//
// Attendu : réponse HTTP 500 `{"error":"Internal Server Error"}` et, dans
// Sentry, un événement portant le tag `function: sentry-selftest`.
// Si le 500 arrive mais pas l'événement, c'est `SENTRY_DSN` qui manque côté
// secrets Supabase — pas le wrapper.
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { withSentry } from '../_shared/sentry.ts'

Deno.serve(withSentry('sentry-selftest', (_req: Request): Promise<Response> => {
  throw new Error('Sentry selftest — exception volontaire, aucun incident réel')
}))
