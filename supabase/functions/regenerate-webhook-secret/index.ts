// ============================================================
// Edge Function : regenerate-webhook-secret
// Génère un nouveau secret HMAC pour le webhook sortant
// Retourne le secret en clair une seule fois
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  // Auth
  let auth
  try {
    auth = await verifyUserAuth(req)
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.message, err.status)
    return errorResponse('Authentication failed', 401)
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch {
    return errorResponse('Server configuration error', 500)
  }

  const orgId = auth.organizationId

  // Check existing config
  const { data: existing } = await supabase
    .from('webhook_configs')
    .select('id')
    .eq('organization_id', orgId)
    .eq('provider', 'webhook')
    .maybeSingle()

  if (!existing) {
    return errorResponse('Aucune configuration webhook trouvée', 404)
  }

  // Generate new secret
  const newSecret = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  // Update
  const { error: updateError } = await supabase
    .from('webhook_configs')
    .update({ webhook_secret: newSecret, failure_count: 0 })
    .eq('id', existing.id)

  if (updateError) {
    return errorResponse('Erreur lors de la régénération du secret', 500)
  }

  // Log in sync_metrics for audit trail
  try {
    await supabase.from('data_syncs').insert({
      organization_id: orgId,
      sync_source: 'manual',
      sync_type: 'webhook',
      sync_status: 'completed',
      triggered_by: 'manual',
      records_processed: 1,
      summary: { action: 'webhook_secret_regenerated' },
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    })
  } catch {
    // Audit log failure must not crash the response
  }

  return jsonResponse({
    success: true,
    message: 'Secret régénéré avec succès',
    secret: newSecret,
  })
})
