/**
 * Environment variable validation — throws on missing required vars.
 * Use these helpers instead of process.env.X! non-null assertions.
 */

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Check your .env.local file.`,
    )
  }
  return value
}

export function getSupabaseUrl(): string {
  return requireEnv('NEXT_PUBLIC_SUPABASE_URL')
}

export function getSupabaseAnonKey(): string {
  return requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY')
}

export function getSupabaseServiceKey(): string {
  return requireEnv('SUPABASE_SERVICE_ROLE_KEY')
}
