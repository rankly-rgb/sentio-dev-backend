// Minimal Deno global shim so Edge Function modules (which call Deno.serve(...)
// at module top level and Deno.env.get(...) inside helpers) can be imported
// directly under vitest/Node for handler-level testing — e.g.
// supabase/tests/accounts-api.test.ts calling the real handleGetOne().
// Deno.serve is a no-op here: the goal is testing exported handler functions
// directly, not spinning up a server.
if (typeof (globalThis as Record<string, unknown>).Deno === 'undefined') {
  ;(globalThis as unknown as { Deno: unknown }).Deno = {
    serve: () => undefined,
    env: { get: (_key: string) => undefined },
  }
}
