import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['supabase/tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['supabase/functions/_shared/**'],
      exclude: ['supabase/functions/_shared/supabase-client.ts'],
    },
  },
})
