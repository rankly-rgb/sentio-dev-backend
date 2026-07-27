// ============================================================
// Edge Function : playbook-crud
// API CRUD RESTful pour la gestion des playbooks
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import {
  validatePlaybookActions,
  validateConditions,
  validateWorkflowSteps,
  calculateNextScheduledAt,
  VALID_PLAYBOOK_STATUSES,
  VALID_PLAYBOOK_TYPES,
  VALID_TEMPLATE_CATEGORIES,
  VALID_PRIORITIES,
  VALID_EXECUTION_FREQUENCIES,
  PLAYBOOK_TEMPLATES_V1,
  type PlaybookStatus,
  type ExecutionFrequency,
} from '../_shared/playbook-engine.ts'

// ── Validation link_redirect_url (chantier C, T022) ──────────
// Anti-open-redirect : validée à l'écriture (schéma https: obligatoire),
// jamais interprétée depuis une requête de lien traçable (playbook-link).
export function isValidHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

// ── Entrypoint ──────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  // Auth : vérifier le JWT utilisateur (ES256)
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
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-crud', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const url = new URL(req.url)
  const id = url.searchParams.get('id')

  const orgId = auth.organizationId

  switch (req.method) {
    case 'POST':
      return handleCreate(supabase, req, orgId)
    case 'GET':
      return id ? handleGetOne(supabase, id, orgId) : handleList(supabase, url, orgId)
    case 'PUT':
    case 'PATCH':
      return id ? handleUpdate(supabase, id, req, orgId) : errorResponse('id query parameter required', 400)
    case 'DELETE':
      return id ? handleArchive(supabase, id, orgId) : errorResponse('id query parameter required', 400)
    default:
      return errorResponse('Method not allowed', 405)
  }
})

// ── CREATE ──────────────────────────────────────────────────

async function handleCreate(supabase: SupabaseClient, req: Request, authOrgId: string): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  // Template creation: enrich body from built-in template constants
  if (body.from_template_id) {
    const template = PLAYBOOK_TEMPLATES_V1.find((t) => t.id === body.from_template_id)
    if (!template) {
      return errorResponse(`Template '${body.from_template_id}' not found`, 404)
    }
    body = {
      ...body,
      title: body.title ?? template.title_en,
      title_en: template.title_en,
      description: body.description ?? template.description_en,
      description_en: template.description_en,
      playbook_type: template.playbook_type,
      template_category: template.template_category,
      priority: template.priority,
      is_automated: template.is_automated,
      is_template: false,
      trigger_conditions: template.trigger_conditions,
      eligibility_criteria: template.eligibility_criteria ?? null,
      actions: template.actions,
      source: 'template',
    }
  }

  // Enforce auth org_id — ignore body.organization_id to prevent cross-tenant writes
  const organizationId = authOrgId
  const title   = body.title    as string | undefined
  const titleEn = body.title_en as string | undefined

  if (!organizationId) return errorResponse('organization_id is required', 400)

  // Validate: title or title_en required
  const hasTitleEn = titleEn && titleEn.trim().length > 0
  const hasTitleLegacy = title && title.trim().length > 0

  if (!hasTitleEn && !hasTitleLegacy) {
    return errorResponse('At least one of title or title_en must be non-empty', 400)
  }

  const resolvedTitle   = hasTitleLegacy ? (title as string).trim() : titleEn!.trim()
  const resolvedTitleEn = hasTitleEn ? titleEn!.trim() : resolvedTitle

  // Determine if workflow
  const isWorkflow = body.is_workflow === true

  // Validate actions (required for non-workflow playbooks, optional for workflows)
  let validatedActions
  if (isWorkflow && !body.actions) {
    validatedActions = [] // Workflows use steps, actions can be empty
  } else {
    try {
      validatedActions = validatePlaybookActions(body.actions)
    } catch (err) {
      return errorResponse(err instanceof Error ? err.message : 'Invalid actions', 400)
    }
  }

  // Validate workflow steps (required for workflows)
  let validatedSteps = null
  if (isWorkflow) {
    if (!body.steps) {
      return errorResponse('steps is required for workflow playbooks', 400)
    }
    try {
      validatedSteps = validateWorkflowSteps(body.steps)
    } catch (err) {
      return errorResponse(err instanceof Error ? err.message : 'Invalid steps', 400)
    }
  }

  // Validate trigger_conditions (optional)
  // Template trigger conditions are stored as raw JSONB — not ConditionGroup format
  let validatedTrigger: unknown = null
  if (body.trigger_conditions) {
    if (body.from_template_id) {
      validatedTrigger = body.trigger_conditions
    } else {
      try {
        validatedTrigger = validateConditions(body.trigger_conditions)
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : 'Invalid trigger_conditions', 400)
      }
    }
  }

  // Validate eligibility_criteria (optional)
  let validatedEligibility: unknown = null
  if (body.eligibility_criteria) {
    if (body.from_template_id) {
      validatedEligibility = body.eligibility_criteria
    } else {
      try {
        validatedEligibility = validateConditions(body.eligibility_criteria)
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : 'Invalid eligibility_criteria', 400)
      }
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
  if (body.link_redirect_url && !isValidHttpsUrl(body.link_redirect_url as string)) {
    return errorResponse('link_redirect_url must be a valid https:// URL', 400)
  }

  const rawDesc   = (body.description    as string | null) ?? null
  const rawDescEn = (body.description_en as string | null) ?? null
  const resolvedDescEn = rawDescEn ?? rawDesc

  const insertPayload: Record<string, unknown> = {
    organization_id: organizationId,
    title: resolvedTitle,
    actions: validatedActions,
    trigger_conditions: validatedTrigger,
    eligibility_criteria: validatedEligibility,
    description: rawDesc,
    description_en: resolvedDescEn,
    playbook_type: (body.playbook_type as string) ?? 'manual',
    template_category: (body.template_category as string) ?? null,
    priority: (body.priority as string) ?? 'medium',
    link_redirect_url: (body.link_redirect_url as string) ?? null,
    source: (body.source as string) ?? 'manual',
    segment_id: (body.segment_id as string) ?? null,
    created_by: (body.created_by as string) ?? null,
    is_automated: (body.is_automated as boolean) ?? false,
    execution_frequency: (body.execution_frequency as string) ?? null,
    is_template: (body.is_template as boolean) ?? false,
    requires_approval: (body.requires_approval as boolean) ?? false,
    is_workflow: isWorkflow,
    steps: validatedSteps,
    status: 'draft',
    title_en: resolvedTitleEn,
  }

  const { data, error } = await supabase
    .from('playbooks')
    .insert(insertPayload)
    .select('*')
    .single()

  if (error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-crud', op: 'create', message: error.message }))
    return errorResponse(`Failed to create playbook: ${error.message}`, 500)
  }

  return jsonResponse(data, 201)
}

// ── LIST ────────────────────────────────────────────────────

async function handleList(supabase: SupabaseClient, url: URL, authOrgId: string): Promise<Response> {
  // Use auth org_id — query param ignored to prevent cross-tenant reads
  const orgId = authOrgId

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

  const isWorkflow = url.searchParams.get('is_workflow')
  if (isWorkflow !== null) query = query.eq('is_workflow', isWorkflow === 'true')

  const { data, error, count } = await query

  if (error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-crud', op: 'list', message: error.message }))
    return errorResponse(`Failed to list playbooks: ${error.message}`, 500)
  }

  const localizedData = (data ?? []).map((p: Record<string, unknown>) => localizePlaybook(p))

  return jsonResponse({ data: localizedData, total: count, page, per_page: perPage })
}

// ── GET ONE ─────────────────────────────────────────────────

async function handleGetOne(supabase: SupabaseClient, id: string, authOrgId: string): Promise<Response> {
  const { data: playbook, error } = await supabase
    .from('playbooks')
    .select('*')
    .eq('id', id)
    .eq('organization_id', authOrgId)
    .single()

  if (error || !playbook) return errorResponse('Playbook not found', 404)

  // Fetch execution stats (limited to last 500 to prevent memory issues)
  const { data: executions } = await supabase
    .from('playbook_executions')
    .select('execution_status, executed_at')
    .eq('playbook_id', id)
    .order('executed_at', { ascending: false })
    .limit(500)

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

  return jsonResponse({ ...localizePlaybook(playbook as Record<string, unknown>), execution_stats: stats })
}

// ── UPDATE ──────────────────────────────────────────────────

async function handleUpdate(supabase: SupabaseClient, id: string, req: Request, authOrgId: string): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  // Fetch current playbook — scoped by org to prevent cross-tenant access
  const { data: current, error: fetchError } = await supabase
    .from('playbooks')
    .select('*')
    .eq('id', id)
    .eq('organization_id', authOrgId)
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

  if (body.description    !== undefined) updates.description    = body.description
  if (body.title_en       !== undefined) updates.title_en       = body.title_en
  if (body.description_en !== undefined) updates.description_en = body.description_en
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

  if (body.link_redirect_url !== undefined) {
    if (body.link_redirect_url !== null && !isValidHttpsUrl(body.link_redirect_url as string)) {
      return errorResponse('link_redirect_url must be a valid https:// URL', 400)
    }
    updates.link_redirect_url = body.link_redirect_url
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
  if (body.is_workflow !== undefined) updates.is_workflow = body.is_workflow

  // Validate and update workflow steps
  if (body.steps !== undefined) {
    if (body.steps === null) {
      updates.steps = null
    } else {
      try {
        updates.steps = validateWorkflowSteps(body.steps)
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : 'Invalid steps', 400)
      }
    }
  }

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
    .eq('organization_id', authOrgId)
    .select('*')
    .single()

  if (updateError) {
    console.error(JSON.stringify({ level: 'error', function_name: 'playbook-crud', op: 'update', message: updateError.message }))
    return errorResponse(`Failed to update playbook: ${updateError.message}`, 500)
  }

  return jsonResponse(data)
}

// ── English display fields ───────────────────────────────────

/**
 * Enrichit un playbook avec display_name et display_description
 * en anglais (title_en/description_en), avec repli sur les
 * colonnes canoniques title/description si absentes.
 */
export function localizePlaybook(
  playbook: Record<string, unknown>,
): Record<string, unknown> {
  const titleEn  = nonEmpty(playbook.title_en as string | null)
  const titleLeg = (playbook.title as string) ?? ''

  const descEn  = nonEmpty(playbook.description_en as string | null)
  const descLeg = (playbook.description as string | null) ?? ''

  return {
    ...playbook,
    display_name: titleEn ?? titleLeg,
    display_description: descEn ?? descLeg,
  }
}

function nonEmpty(v: string | null | undefined): string | null {
  return v && v.trim().length > 0 ? v : null
}

// ── ARCHIVE (soft delete) ───────────────────────────────────

async function handleArchive(supabase: SupabaseClient, id: string, authOrgId: string): Promise<Response> {
  const { data, error } = await supabase
    .from('playbooks')
    .update({
      status: 'archived',
      deactivated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('organization_id', authOrgId)
    .select('id, status, deactivated_at')
    .single()

  if (error || !data) {
    return errorResponse('Playbook not found', 404)
  }

  return jsonResponse({ message: 'Playbook archived', ...data })
}
