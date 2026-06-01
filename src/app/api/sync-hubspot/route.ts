import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const maxDuration = 60

export async function POST() {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Non authentifié' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('profiles_')
    .select('organization_id, role')
    .eq('auth_user_id', user.id)
    .maybeSingle()

  if (!profile?.organization_id) {
    return NextResponse.json({ error: 'Aucune organisation' }, { status: 403 })
  }

  // Rate limit : 60s entre chaque sync HubSpot
  const { data: lastSync } = await supabase
    .from('data_syncs')
    .select('created_at')
    .eq('organization_id', profile.organization_id)
    .eq('sync_source', 'hubspot')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (lastSync?.created_at && Date.now() - new Date(lastSync.created_at).getTime() < 60_000) {
    return NextResponse.json(
      { error: 'Sync trop fréquent. Attendez 1 minute entre chaque synchronisation.' },
      { status: 429 },
    )
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: 'Configuration serveur manquante' }, { status: 500 })
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 55_000)

    const resp = await fetch(`${supabaseUrl}/functions/v1/sync-hubspot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        organization_id: profile.organization_id,
        sync_type: 'incremental',
        is_manual: true,
      }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    const data = await resp.json()

    if (!resp.ok) {
      return NextResponse.json(
        { error: data.error ?? 'Échec de la synchronisation HubSpot' },
        { status: resp.status },
      )
    }

    return NextResponse.json(data)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
