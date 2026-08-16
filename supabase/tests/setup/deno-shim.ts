// Minimal Deno global shim so Edge Function modules (which call Deno.serve(...)
// at module top level and Deno.env.get(...) inside helpers) can be imported
// directly under vitest/Node for handler-level testing — e.g.
// supabase/tests/accounts-api.test.ts calling the real handleGetOne().
// Deno.serve is a no-op here: the goal is testing exported handler functions
// directly, not spinning up a server.
//
// `Deno.env.get` lit une table d'overrides vide par défaut : le comportement
// historique (toujours `undefined`) est donc inchangé pour les tests
// existants. Un test qui a besoin d'une variable d'environnement la pose dans
// `globalThis.__DENO_ENV__` et la retire après (voir sentry-cron.test.ts).
const denoEnv: Record<string, string | undefined> = {}
;(globalThis as unknown as { __DENO_ENV__: Record<string, string | undefined> }).__DENO_ENV__ = denoEnv

if (typeof (globalThis as Record<string, unknown>).Deno === 'undefined') {
  ;(globalThis as unknown as { Deno: unknown }).Deno = {
    serve: () => undefined,
    env: { get: (key: string) => denoEnv[key] },
  }
}
