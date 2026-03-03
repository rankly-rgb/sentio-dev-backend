// ============================================================
// Edge Function : playbook-crud
// API CRUD RESTful pour la gestion des playbooks
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import {
  validatePlaybookActions,
  validateConditions,
  calculateNextScheduledAt,
  VALID_PLAYBOOK_STATUSES,
  VALID_PLAYBOOK_TYPES,
  VALID_TEMPLATE_CATEGORIES,
  VALID_PRIORITIES,
  VALID_EXECUTION_FREQUENCIES,
  type PlaybookStatus,
  type ExecutionFrequency,
} from '../_shared/playbook-engine.ts'

// ── Entrypoint ──────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  let supabase: SupabaseClient
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-crud', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const url = new URL(req.url)
  const id = url.searchParams.get('id')

  switch (req.method) {
    case 'POST':
      return handleCreate(supabase, req)
    case 'GET':
      return id ? handleGetOne(supabase, id) : handleList(supabase, url)
    case 'PUT':
    case 'PATCH':
      return id ? handleUpdate(supabase, id, req) : errorResponse('id query parameter required', 400)
    case 'DELETE':
      return id ? handleArchive(supabase, id) : errorResponse('id query parameter required', 400)
    default:
      return errorResponse('Method not allowed', 405)
  }
})

// ── CREATE ──────────────────────────────────────────────────

async function handleCreate(supabase: SupabaseClient, req: Request): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  const organizationId = body.organization_id as string | undefined
  const title = body.title as string | undefined

  if (!organizationId) return errorResponse('organization_id is required', 400)
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return errorResponse('title is required and must be a non-empty string', 400)
  }

  // Validate actions
  let validatedActions
  try {
    validatedActions = validatePlaybookActions(body.actions)
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Invalid actions', 400)
  }

  // Validate trigger_conditions (optional)
  let validatedTrigger = null
  if (body.trigger_conditions) {
    try {
      validatedTrigger = validateConditions(body.trigger_conditions)
    } catch (err) {
      return errorResponse(err instanceof Error ? err.message : 'Invalid trigger_conditions', 400)
    }
  }

  // Validate eligibility_criteria (optional)
  let validatedEligibility = null
  if (body.eligibility_criteria) {
    try {
      validatedEligibility = validateConditions(body.eligibility_criteria)
    } catch (err) {
      return errorResponse(err instanceof Error ? err.message : 'Invalid eligibility_criteria', 400)
    }
  }

  // Validate optional enum fields
  if (body.playbook_type && !(VALID_PLAYBOOK_TYPES as readonly string[]).includes(body.playbook_type as string)) {
    return errorResponse(`playbook_type must be one of: ${VALID_PLAYBOOK_TYPES.join(', ')}`, 400)
  }
  if (body.template_category && !(VALID_TEMPLATE_CATEGORIES as readonly string[]).includes(body.template_category as string)) {
    return errorResponse(`template_category must be one of: ${VALID_TEMPLATE_CATEGORIES.join(', ')}`, 400)
  }
  if (body.priority && !(VALID_PRIORITIES as readonly string[]).includes(body.priority as string)) {
    return errorResponse(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`, 400)
  }

  const { data, error } = await supabase
    .from('playbooks')
    .insert({
      organization_id: organizationId,
      title: title.trim(),
      actions: validatedActions,
      trigger_conditions: validatedTrigger,
      eligibility_criteria: validatedEligibility,
      description: (body.description as string) ?? null,
      playbook_type: (body.playbook_type as string) ?? 'manual',
      template_category: (body.template_category as string) ?? null,
      priority: (body.priority as string) ?? 'medium',
      source: (body.source as string) ?? 'manual',
      segment_id: (body.segment_id as string) ?? null,
      created_by: (body.created_by as string) ?? null,
      is_automated: (body.is_automated as boolean) ?? false,
      execution_frequency: (body.execution_frequency as string) ?? null,
      is_template: (body.is_template as boolean) ?? false,
      requires_approval: (body.requires_approval as boolean) ?? false,
      status: 'draft',
    })
    .select('*')
    .single()

  if (error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-crud', op: 'create', message: error.message }))
    return errorResponse(`Failed to create playbook: ${error.message}`, 500)
  }

  return jsonResponse(data, 201)
}

// ── LIST ────────────────────────────────────────────────────

async function handleList(supabase: SupabaseClient, url: URL): Promise<Response> {
  const orgId = url.searchParams.get('organization_id')
  if (!orgId) return errorResponse('organization_id query parameter required', 400)

  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10))
  const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') ?? '20', 10)))
  const from = (page - 1) * perPage
  const to = page * perPage - 1

  let query = supabase
    .from('playbooks')
    .select('*', { count: 'exact' })
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .range(from, to)

  // Filtre statut : par défaut exclure archived
  const status = url.searchParams.get('status')
  if (status) {
    query = query.eq('status', status)
  } else {
    query = query.neq('status', 'archived')
  }

  const segmentId = url.searchParams.get('segment_id')
  if (segmentId) query = query.eq('segment_id', segmentId)

  const playbookType = url.searchParams.get('playbook_type')
  if (playbookType) query = query.eq('playbook_type', playbookType)

  const templateCategory = url.searchParams.get('template_category')
  if (templateCategory) query = query.eq('template_category', templateCategory)

  const isTemplate = url.searchParams.get('is_template')
  if (isTemplate !== null) query = query.eq('is_template', isTemplate === 'true')

  const { data, error, count } = await query

  if (error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-crud', op: 'list', message: error.message }))
    return errorResponse(`Failed to list playbooks: ${error.message}`, 500)
  }

  return jsonResponse({ data, total: count, page, per_page: perPage })
}

// ── GET ONE ─────────────────────────────────────────────────

async function handleGetOne(supabase: SupabaseClient, id: string): Promise<Response> {
  const { data: playbook, error } = await supabase
    .from('playbooks')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !playbook) return errorResponse('Playbook not found', 404)

  // Fetch execution stats
  const { data: executions } = await supabase
    .from('playbook_executions')
    .select('execution_status, executed_at')
    .eq('playbook_id', id)

  const executionList = executions ?? []
  const stats = {
    total_executions: executionList.length,
    completed: executionList.filter((e: Record<string, unknown>) => e.execution_status === 'completed').length,
    failed: executionList.filter((e: Record<string, unknown>) => e.execution_status === 'failed').length,
    running: executionList.filter((e: Record<string, unknown>) => e.execution_status === 'running').length,
    pending: executionList.filter((e: Record<string, unknown>) => e.execution_status === 'pending').length,
    last_executed_at: executionList.length > 0
      ? executionList
          .filter((e: Record<string, unknown>) => e.executed_at)
          .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
            (b.executed_at as string).localeCompare(a.executed_at as string))
          [0]?.executed_at ?? null
      : null,
  }

  return jsonResponse({ ...playbook, execution_stats: stats })
}

// ── UPDATE ──────────────────────────────────────────────────

async function handleUpdate(supabase: SupabaseClient, id: string, req: Request): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  // Fetch current playbook
  const { data: current, error: fetchError } = await supabase
    .from('playbooks')
    .select('*')
    .eq('id', id)
    .single()

  if (fetchError || !current) return errorResponse('Playbook not found', 404)

  const updates: Record<string, unknown> = {}

  // Validate and set fields
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || (body.title as string).trim().length === 0) {
      return errorResponse('title must be a non-empty string', 400)
    }
    updates.title = (body.title as string).trim()
  }

  if (body.description !== undefined) updates.description = body.description
  if (body.segment_id !== undefined) updates.segment_id = body.segment_id
  if (body.insight_id !== undefined) updates.insight_id = body.insight_id

  if (body.actions !== undefined) {
    try {
      updates.actions = validatePlaybookActions(body.actions)
    } catch (err) {
      return errorResponse(err instanceof Error ? err.message : 'Invalid actions', 400)
    }
  }

  if (body.trigger_conditions !== undefined) {
    try {
      updates.trigger_conditions = validateConditions(body.trigger_conditions)
    } catch (err) {
      return errorResponse(err instanceof Error ? err.message : 'Invalid trigger_conditions', 400)
    }
  }

  if (body.eligibility_criteria !== undefined) {
    try {
      updates.eligibility_criteria = validateConditions(body.eligibility_criteria)
    } catch (err) {
      return errorResponse(err instanceof Error ? err.message : 'Invalid eligibility_criteria', 400)
    }
  }

  if (body.playbook_type !== undefined) {
    if (!(VALID_PLAYBOOK_TYPES as readonly string[]).includes(body.playbook_type as string)) {
      return errorResponse(`playbook_type must be one of: ${VALID_PLAYBOOK_TYPES.join(', ')}`, 400)
    }
    updates.playbook_type = body.playbook_type
  }

  if (body.template_category !== undefined) {
    if (body.template_category !== null &&
        !(VALID_TEMPLATE_CATEGORIES as readonly string[]).includes(body.template_category as string)) {
      return errorResponse(`template_category must be one of: ${VALID_TEMPLATE_CATEGORIES.join(', ')}`, 400)
    }
    updates.template_category = body.template_category
  }

  if (body.priority !== undefined) {
    if (!(VALID_PRIORITIES as readonly string[]).includes(body.priority as string)) {
      return errorResponse(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`, 400)
    }
    updates.priority = body.priority
  }

  if (body.is_automated !== undefined) updates.is_automated = body.is_automated
  if (body.execution_frequency !== undefined) {
    if (body.execution_frequency !== null &&
        !(VALID_EXECUTION_FREQUENCIES as readonly string[]).includes(body.execution_frequency as string)) {
      return errorResponse(`execution_frequency must be one of: ${VALID_EXECUTION_FREQUENCIES.join(', ')}`, 400)
    }
    updates.execution_frequency = body.execution_frequency
  }
  if (body.is_template !== undefined) updates.is_template = body.is_template
  if (body.requires_approval !== undefined) updates.requires_approval = body.requires_approval

  // Handle status transitions
  if (body.status !== undefined) {
    const newStatus = body.status as PlaybookStatus
    if (!(VALID_PLAYBOOK_STATUSES as readonly string[]).includes(newStatus)) {
      return errorResponse(`status must be one of: ${VALID_PLAYBOOK_STATUSES.join(', ')}`, 400)
    }

    const currentStatus = current.status as string

    // draft → active : set activated_at, check approval
    if (newStatus === 'active' && currentStatus !== 'active') {
      if (current.requires_approval && !current.approved_by && !body.approved_by) {
        return errorResponse('Playbook requires approval before activation', 400)
      }
      updates.activated_at = new Date().toISOString()

      // Si automated, calculer next_scheduled_at
      const isAutomated = (body.is_automated ?? current.is_automated) as boolean
      const frequency = (body.execution_frequency ?? current.execution_frequency) as string | null
      if (isAutomated && frequency &&
          (VALID_EXECUTION_FREQUENCIES as readonly string[]).includes(frequency)) {
        updates.next_scheduled_at = calculateNextScheduledAt(frequency as ExecutionFrequency)
      }
    }

    // → archived : set deactivated_at
    if (newStatus === 'archived') {
      updates.deactivated_at = new Date().toISOString()
      updates.deactivation_reason = (body.deactivation_reason as string) ?? null
    }

    // → completed : set completed_at
    if (newStatus === 'completed') {
      updates.completed_at = new Date().toISOString()
    }

    updates.status = newStatus
  }

  // Handle approval
  if (body.approved_by !== undefined) {
    updates.approved_by = body.approved_by
    updates.approved_at = new Date().toISOString()
  }

  if (Object.keys(updates).length === 0) {
    return errorResponse('No fields to update', 400)
  }

  const { data, error: updateError } = await supabase
    .from('playbooks')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single()

  if (updateError) {
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-crud', op: 'update', message: updateError.message }))
    return errorResponse(`Failed to update playbook: ${updateError.message}`, 500)
  }

  return jsonResponse(data)
}

// ── ARCHIVE (soft delete) ───────────────────────────────────

async function handleArchive(supabase: SupabaseClient, id: string): Promise<Response> {
  const { data, error } = await supabase
    .from('playbooks')
    .update({
      status: 'archived',
      deactivated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('id, status, deactivated_at')
    .single()

  if (error || !data) {
    return errorResponse('Playbook not found', 404)
  }

  return jsonResponse({ message: 'Playbook archived', ...data })
}
