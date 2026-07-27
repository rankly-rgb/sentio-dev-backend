// ============================================================
// Edge Function : playbook-templates-crud
// CRUD de la bibliothèque de templates de message par catégorie
// de playbook (playbook_message_templates) — alimente playbook-export.
// Nom distinct de `playbook-templates` (templates de PLAYBOOK V1
// constants) pour éviter toute confusion, cf. research.md.
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { VALID_TEMPLATE_CATEGORIES } from '../_shared/playbook-engine.ts'

const MAX_BODY_LENGTH = 2000

// ── Entrypoint ──────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  let auth
  try {
    auth = await verifyUserAuth(req)
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.message, err.status)
    return errorResponse('Authentication failed', 401)
  }

  let supabase: SupabaseClient
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-templates-crud', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  const orgId = auth.organizationId

  switch (req.method) {
    case 'GET':
      return handleList(supabase, url, orgId)
    case 'POST':
      return handleCreate(supabase, req, orgId)
    case 'PATCH':
    case 'PUT':
      return id ? handleUpdate(supabase, id, req, orgId) : errorResponse('id query parameter required', 400)
    default:
      return errorResponse('Method not allowed', 405)
  }
})

// ── Validation ──────────────────────────────────────────────

function validateTemplateCategory(value: unknown): string | null {
  if (typeof value !== 'string' || !(VALID_TEMPLATE_CATEGORIES as readonly string[]).includes(value)) {
    return null
  }
  return value
}

function validateNonEmpty(value: unknown, maxLength?: number): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  if (maxLength !== undefined && value.length > maxLength) return null
  return value
}

/**
 * Garantit qu'un seul template `is_default=true` existe par
 * (organization_id, template_category) — désactive les autres avant
 * d'écrire le nouveau, pour respecter l'index unique partiel.
 */
async function clearOtherDefaults(
  supabase: SupabaseClient,
  orgId: string,
  templateCategory: string,
  excludeId?: string,
): Promise<void> {
  let query = supabase
    .from('playbook_message_templates')
    .update({ is_default: false })
    .eq('organization_id', orgId)
    .eq('template_category', templateCategory)
    .eq('is_default', true)

  if (excludeId) query = query.neq('id', excludeId)

  await query
}

// ── LIST ────────────────────────────────────────────────────

export async function handleList(supabase: SupabaseClient, url: URL, orgId: string): Promise<Response> {
  let query = supabase
    .from('playbook_message_templates')
    .select('*', { count: 'exact' })
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })

  const templateCategory = url.searchParams.get('template_category')
  if (templateCategory) query = query.eq('template_category', templateCategory)

  const { data, error, count } = await query

  if (error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-templates-crud', op: 'list', message: error.message }))
    return errorResponse('Failed to list templates', 500)
  }

  return jsonResponse({ data: data ?? [], total: count ?? 0 })
}

// ── CREATE ──────────────────────────────────────────────────

export async function handleCreate(supabase: SupabaseClient, req: Request, orgId: string): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  const templateCategory = validateTemplateCategory(body.template_category)
  if (!templateCategory) {
    return errorResponse(`template_category must be one of: ${VALID_TEMPLATE_CATEGORIES.join(', ')}`, 400)
  }

  const name = validateNonEmpty(body.name)
  if (!name) return errorResponse('name must be a non-empty string', 400)

  const templateBody = validateNonEmpty(body.body, MAX_BODY_LENGTH)
  if (!templateBody) return errorResponse(`body must be a non-empty string of at most ${MAX_BODY_LENGTH} characters`, 400)

  const isActive = body.is_active !== false
  const isDefault = body.is_default === true

  if (isDefault) {
    await clearOtherDefaults(supabase, orgId, templateCategory)
  }

  const { data, error } = await supabase
    .from('playbook_message_templates')
    .insert({
      organization_id: orgId,
      template_category: templateCategory,
      name,
      body: templateBody,
      is_active: isActive,
      is_default: isDefault,
    })
    .select('*')
    .single()

  if (error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-templates-crud', op: 'create', message: error.message }))
    return errorResponse(`Failed to create template: ${error.message}`, 500)
  }

  return jsonResponse(data, 201)
}

// ── UPDATE ──────────────────────────────────────────────────

export async function handleUpdate(supabase: SupabaseClient, id: string, req: Request, orgId: string): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  const { data: current, error: fetchError } = await supabase
    .from('playbook_message_templates')
    .select('*')
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle()

  if (fetchError || !current) return errorResponse('Template not found', 404)

  const updates: Record<string, unknown> = {}

  if (body.name !== undefined) {
    const name = validateNonEmpty(body.name)
    if (!name) return errorResponse('name must be a non-empty string', 400)
    updates.name = name
  }

  if (body.body !== undefined) {
    const templateBody = validateNonEmpty(body.body, MAX_BODY_LENGTH)
    if (!templateBody) return errorResponse(`body must be a non-empty string of at most ${MAX_BODY_LENGTH} characters`, 400)
    updates.body = templateBody
  }

  if (body.is_active !== undefined) updates.is_active = body.is_active === true

  if (body.is_default !== undefined) {
    updates.is_default = body.is_default === true
    if (updates.is_default) {
      await clearOtherDefaults(supabase, orgId, current.template_category as string, id)
    }
  }

  if (Object.keys(updates).length === 0) {
    return errorResponse('No fields to update', 400)
  }

  const { data, error: updateError } = await supabase
    .from('playbook_message_templates')
    .update(updates)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('*')
    .single()

  if (updateError) {
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-templates-crud', op: 'update', message: updateError.message }))
    return errorResponse(`Failed to update template: ${updateError.message}`, 500)
  }

  return jsonResponse(data)
}
