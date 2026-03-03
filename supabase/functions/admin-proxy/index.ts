// ============================================================
// admin-proxy — Proxy sécurisé pour les fonctions admin
// Remplace l'exposition du service_role key dans le frontend.
// Vérifie le JWT utilisateur + rôle admin/owner + org_id match
// avant de router vers la fonction cible avec le service_role.
// ============================================================

import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, jsonResponse, errorResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { createLogger } from '../_shared/structured-logger.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'

const ALLOWED_ACTIONS = ['sync-stripe', 'calculate-scores', 'health-check', 'self-monitor'] as const
type AllowedAction = typeof ALLOWED_ACTIONS[number]

interface ProxyRequest {
  action: AllowedAction
  organization_id?: string
  sync_type?: 'incremental' | 'full_sync'
  is_manual?: boolean
}

// Actions qui nécessitent un organization_id
const ACTIONS_REQUIRING_ORG: AllowedAction[] = ['sync-stripe', 'calculate-scores']

Deno.serve(async (req: Request): Promise<Response> => {
  // 1. CORS
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  // 2. Méthode
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  const correlationId = crypto.randomUUID()
  const logger = createLogger({
    correlation_id: correlationId,
    function_name: 'admin-proxy',
  })

  // 3. Auth — vérifier le JWT utilisateur
  let userId: string
  let userOrgId: string
  try {
    const auth = await verifyUserAuth(req)
    userId = auth.userId
    userOrgId = auth.organizationId
  } catch (err) {
    if (err instanceof AuthError) {
      logger.warn('Auth failed', { error: err.message, status: err.status })
      return errorResponse(err.message, err.status)
    }
    logger.error('Auth unexpected error', { error: String(err) })
    return errorResponse('Authentication error', 500)
  }

  // 4. Service client pour vérifier le rôle
  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    logger.error('Service client creation failed', { error: String(err) })
    return errorResponse('Server configuration error', 500)
  }

  // 5. Vérifier le rôle admin/owner
  const { data: profile, error: profileError } = await supabase
    .from('profiles_')
    .select('role')
    .eq('auth_user_id', userId)
    .single()

  if (profileError || !profile) {
    logger.warn('Profile not found', { userId })
    return errorResponse('User profile not found', 403)
  }

  if (profile.role !== 'admin' && profile.role !== 'owner') {
    logger.warn('Insufficient role', { userId, role: profile.role })
    return errorResponse('Insufficient permissions: admin or owner role required', 403)
  }

  // 6. Parser le body
  let body: ProxyRequest
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  // 7. Valider l'action
  if (!body.action || !ALLOWED_ACTIONS.includes(body.action as AllowedAction)) {
    return errorResponse(
      `Unknown action: ${body.action}. Allowed: ${ALLOWED_ACTIONS.join(', ')}`,
      400
    )
  }

  const action = body.action as AllowedAction

  // 8. Vérifier org_id pour les actions qui le nécessitent
  if (ACTIONS_REQUIRING_ORG.includes(action)) {
    if (!body.organization_id) {
      return errorResponse('organization_id is required for this action', 400)
    }
    if (body.organization_id !== userOrgId) {
      logger.warn('Org mismatch', {
        userId,
        requestedOrg: body.organization_id,
        userOrg: userOrgId,
      })
      return errorResponse('organization_id does not match your organization', 403)
    }
  }

  // 9. Construire la requête vers la fonction cible
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !serviceRoleKey) {
    logger.error('Missing env vars for proxy call')
    return errorResponse('Server configuration error', 500)
  }

  const targetUrl = `${supabaseUrl}/functions/v1/${action}`

  // Construire les options de la requête cible
  const isGet = action === 'health-check'
  const targetHeaders: Record<string, string> = {
    'Authorization': `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  }

  let targetBody: string | undefined
  if (!isGet) {
    if (action === 'sync-stripe') {
      targetBody = JSON.stringify({
        organization_id: body.organization_id,
        sync_type: body.sync_type || 'incremental',
        is_manual: body.is_manual ?? true,
      })
    } else if (action === 'calculate-scores') {
      targetBody = JSON.stringify({
        organization_id: body.organization_id,
      })
    } else if (action === 'self-monitor') {
      targetBody = JSON.stringify({})
    }
  }

  // 10. Log audit
  logger.info('Proxy call', {
    action,
    userId,
    organization_id: body.organization_id || null,
    role: profile.role,
  })

  // 11. Appeler la fonction cible
  try {
    const response = await fetchWithTimeout(
      targetUrl,
      {
        method: isGet ? 'GET' : 'POST',
        headers: targetHeaders,
        body: isGet ? undefined : targetBody,
      },
      30000 // 30s timeout — les syncs peuvent être longs
    )

    const responseBody = await response.text()

    // Parser la réponse pour s'assurer de ne pas leaker le service_role
    let parsed: unknown
    try {
      parsed = JSON.parse(responseBody)
    } catch {
      parsed = { message: responseBody }
    }

    if (!response.ok) {
      logger.warn('Target function error', {
        action,
        status: response.status,
        response: responseBody.substring(0, 500),
      })
      return jsonResponse(
        { error: `Target function error: ${action}`, details: parsed },
        502
      )
    }

    logger.info('Proxy call succeeded', { action, status: response.status })
    return jsonResponse(parsed, response.status)
  } catch (err) {
    logger.error('Proxy call failed', {
      action,
      error: String(err),
    })
    return jsonResponse(
      { error: `Failed to call ${action}`, details: String(err) },
      502
    )
  }
})
