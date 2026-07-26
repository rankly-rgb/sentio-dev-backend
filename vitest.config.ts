import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Deno-only specifiers used by Edge Function source files. Aliased so
      // tests can import handler modules directly (e.g. accounts-api.test.ts)
      // instead of duplicating handler logic — see also setupFiles below.
      'jsr:@supabase/supabase-js@2': '@supabase/supabase-js',
      'jsr:@supabase/functions-js/edge-runtime.d.ts': './supabase/tests/__stubs__/deno-edge-runtime-stub.ts',
    },
  },
  test: {
    include: ['supabase/tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./supabase/tests/setup/deno-shim.ts'],
    coverage: {
      provider: 'v8',
      include: ['supabase/functions/_shared/**'],
      exclude: ['supabase/functions/_shared/supabase-client.ts'],
    },
  },
})
