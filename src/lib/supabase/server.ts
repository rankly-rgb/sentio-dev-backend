import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { getSupabaseUrl, getSupabaseAnonKey, getSupabaseServiceKey } from '@/lib/env'

export function createSupabaseServerClient() {
  const cookieStore = cookies()
  return createServerClient(
    getSupabaseUrl(),
    getSupabaseAnonKey(),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options)
            })
          } catch {
            // Lecture seule en Server Component — ignoré
          }
        },
      },
    },
  )
}

export function createSupabaseServiceClient() {
  const { createClient } = require('@supabase/supabase-js')
  return createClient(
    getSupabaseUrl(),
    getSupabaseServiceKey(),
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
}
