import { NextResponse } from 'next/server'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'

export async function POST() {
  // 1. Vérifier l'auth utilisateur
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Non authentifié' }, { status: 401 })
  }

  // 2. Récupérer l'organization_id du profil
  const { data: profile } = await supabase
    .from('profiles_')
    .select('organization_id, role')
    .eq('auth_user_id', user.id)
    .single()

  if (!profile?.organization_id) {
    return NextResponse.json({ error: 'Aucune organisation' }, { status: 403 })
  }

  // 3. Appeler l'Edge Function sync-stripe via service role
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/sync-stripe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        organization_id: profile.organization_id,
        sync_type: 'incremental',
        is_manual: true,
      }),
    })

    const data = await resp.json()

    if (!resp.ok) {
      return NextResponse.json(
        { error: data.error ?? 'Échec de la synchronisation' },
        { status: resp.status },
      )
    }

    return NextResponse.json(data)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
