'use client'

import { createBrowserClient } from '@supabase/ssr'

// NEXT_PUBLIC_ vars are inlined at build time, so we validate at runtime
function requirePublicEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

let _client: ReturnType<typeof createBrowserClient> | null = null

export function createSupabaseBrowserClient() {
  if (!_client) {
    _client = createBrowserClient(
      requirePublicEnv('NEXT_PUBLIC_SUPABASE_URL'),
      requirePublicEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    )
  }
  return _client
}
