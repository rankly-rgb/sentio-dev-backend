import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

export async function GET() {
  const start = Date.now()
  const checks: Record<string, { status: string; latency_ms?: number }> = {}

  // 1. Environment variables
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey) {
    checks.env = { status: 'fail' }
    return NextResponse.json(
      { status: 'unhealthy', checks, uptime: process.uptime() },
      { status: 503 },
    )
  }
  checks.env = { status: 'ok' }

  // 2. Supabase connectivity
  try {
    const dbStart = Date.now()
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
    })
    const { error } = await supabase
      .from('organizations')
      .select('id', { count: 'exact', head: true })

    checks.database = {
      status: error ? 'degraded' : 'ok',
      latency_ms: Date.now() - dbStart,
    }
  } catch {
    checks.database = { status: 'fail', latency_ms: Date.now() - start }
  }

  const allOk = Object.values(checks).every((c) => c.status === 'ok')

  return NextResponse.json(
    {
      status: allOk ? 'healthy' : 'degraded',
      checks,
      latency_ms: Date.now() - start,
      uptime: process.uptime(),
    },
    { status: allOk ? 200 : 503 },
  )
}
