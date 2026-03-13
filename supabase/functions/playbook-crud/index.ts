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
  evaluateConditions,
  enrichPlaybooksWithEligibleCount,
  executeAction,
  VALID_PLAYBOOK_STATUSES,
  VALID_PLAYBOOK_TYPES,
  VALID_TEMPLATE_CATEGORIES,
  VALID_PRIORITIES,
  VALID_EXECUTION_FREQUENCIES,
  type PlaybookStatus,
  type PlaybookAction,
  type AccountData,
  type ActionResult,
  type ExecutionFrequency,
} from '../_shared/playbook-engine.ts'
import { canApprove, canReject, isPlaybookMatch, buildApprovalLog } from '../_shared/playbook-approval-helpers.ts'
import {
  buildConditionsDisplay,
  buildActionsDisplay,
  buildEligibleAccountsSummary,
  buildEligibleAccountRow,
  type EligibleAccountRow,
} from '../_shared/playbook-detail-helpers.ts'

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

  // Sub-path routing for approval endpoints: /{id}/approve-execution, /{id}/reject-execution
  const subPathMatch = url.pathname.match(/\/playbook-crud\/([^/]+)\/(approve-execution|reject-execution)/)
  if (subPathMatch && req.method === 'POST') {
    const playbookId = subPathMatch[1]
    const action = subPathMatch[2]
    if (action === 'approve-execution') {
      return handleApproveExecution(supabase, playbookId, req, orgId)
    }
    return handleRejectExecution(supabase, playbookId, req, orgId)
  }

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

  // Enforce auth org_id — ignore body.organization_id to prevent cross-tenant writes
  const organizationId = authOrgId
  const title = body.title as string | undefined

  if (!organizationId) return errorResponse('organization_id is required', 400)
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return errorResponse('title is required and must be a non-empty string', 400)
  }

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

  const insertPayload: Record<string, unknown> = {
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
    is_workflow: isWorkflow,
    steps: validatedSteps,
    status: 'draft',
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

  // Enrich playbooks with current_eligible_count
  const playbooks = data ?? []
  const hasEligibility = playbooks.some(
    (pb: Record<string, unknown>) =>
      pb.eligibility_criteria &&
      typeof pb.eligibility_criteria === 'object' &&
      (pb.eligibility_criteria as Record<string, unknown>).conditions,
  )

  let enrichedData = playbooks
  if (hasEligibility && playbooks.length > 0) {
    const { data: accounts } = await supabase
      .from('accounts')
      .select('id, organization_id, health_score, churn_risk_score, expansion_score, product_usage_score, mrr_cents, arr_cents, plan_tier, seat_count, seat_limit, contract_start_date, contract_end_date, created_at')
      .eq('organization_id', orgId)
      .limit(10000)

    enrichedData = enrichPlaybooksWithEligibleCount(playbooks, accounts ?? [])
  } else {
    // No eligibility criteria → all accounts are eligible for each playbook
    enrichedData = playbooks.map((pb: Record<string, unknown>) => ({
      ...pb,
      current_eligible_count: 0,
    }))
  }

  return jsonResponse({ data: enrichedData, total: count, page, per_page: perPage })
}

// ── GET ONE ─────────────────────────────────────────────────

async function handleGetOne(supabase: SupabaseClient, id: string, authOrgId: string): Promise<Response> {
  const { data: playbook, error } = await supabase
    .from('playbooks')
    .select('*')
    .eq('id', id)
    .eq('organization_id', authOrgId)
    .maybeSingle()

  if (error || !playbook) return errorResponse('Playbook not found', 404)

  // Fetch execution stats (limited to last 500 to prevent memory issues)
  const { data: executions } = await supabase
    .from('playbook_executions')
    .select('execution_status, account_id, account_converted, mrr_recovered_cents, mrr_expansion_cents, executed_at')
    .eq('playbook_id', id)
    .eq('organization_id', authOrgId)
    .order('executed_at', { ascending: false })
    .limit(500)

  const executionList = (executions ?? []) as Array<{
    execution_status: string
    account_id: string
    account_converted?: boolean | null
    mrr_recovered_cents?: number | null
    mrr_expansion_cents?: number | null
    executed_at?: string | null
  }>

  // Compute execution stats
  const uniqueAccounts = new Set<string>()
  const reachedAccounts = new Set<string>()
  const convertedAccounts = new Set<string>()
  let mrrRecovered = 0
  let mrrExpansion = 0
  let completedCount = 0
  let failedCount = 0
  let inProgressCount = 0

  for (const exec of executionList) {
    uniqueAccounts.add(exec.account_id)
    if (exec.execution_status === 'completed' || exec.execution_status === 'running' || exec.execution_status === 'partially_completed') {
      reachedAccounts.add(exec.account_id)
    }
    if (exec.execution_status === 'completed') completedCount++
    else if (exec.execution_status === 'failed') failedCount++
    else if (exec.execution_status === 'running' || exec.execution_status === 'pending') inProgressCount++
    if (exec.account_converted) convertedAccounts.add(exec.account_id)
    mrrRecovered += exec.mrr_recovered_cents ?? 0
    mrrExpansion += exec.mrr_expansion_cents ?? 0
  }

  const executionStats = {
    total: executionList.length,
    completed: completedCount,
    failed: failedCount,
    in_progress: inProgressCount,
    targeted_count: uniqueAccounts.size,
    reached_count: reachedAccounts.size,
    converted_count: convertedAccounts.size,
    mrr_recovered_cents: mrrRecovered,
    mrr_expansion_cents: mrrExpansion,
  }

  // Compute eligible accounts using in-memory evaluation (same as list endpoint)
  let eligibleAccountRows: EligibleAccountRow[] = []
  if (playbook.eligibility_criteria) {
    const { data: accounts } = await supabase
      .from('accounts')
      .select('id, stripe_customer_id, health_score, churn_risk_score, expansion_score, product_usage_score, mrr_cents, arr_cents, plan_tier, seat_count, seat_limit, contract_start_date, contract_end_date, created_at')
      .eq('organization_id', authOrgId)
      .limit(10000)

    const eligible = (accounts ?? []).filter((a: Record<string, unknown>) =>
      evaluateConditions(playbook.eligibility_criteria, a))
    eligibleAccountRows = eligible.map((a: Record<string, unknown>) => buildEligibleAccountRow(a as Record<string, unknown> & { id: string }))
  }

  const eligibleAccountsSummary = buildEligibleAccountsSummary(eligibleAccountRows)

  // Build unified response — single "eligible_accounts" block, no duplication
  return jsonResponse({
    playbook: {
      id: playbook.id,
      title: playbook.title,
      description: playbook.description,
      status: playbook.status,
      priority: playbook.priority,
      playbook_type: playbook.playbook_type,
      template_category: playbook.template_category,
      is_automated: playbook.is_automated,
      requires_approval: playbook.requires_approval,
      is_template: playbook.is_template,
      execution_frequency: playbook.execution_frequency,
      last_executed_at: playbook.last_executed_at,
      created_at: playbook.created_at,
      updated_at: playbook.updated_at,
    },
    eligible_accounts: eligibleAccountsSummary,
    execution_stats: executionStats,
    conditions: buildConditionsDisplay(playbook.eligibility_criteria),
    actions: buildActionsDisplay(playbook.actions),
    eligible_accounts_list: eligibleAccountRows,
  })
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

// ── APPROVE EXECUTION ───────────────────────────────────────
// POST /functions/v1/playbook-crud/{id}/approve-execution
// Authorization: Bearer <supabase_jwt>
//
// Body: { execution_id: string }
//
// Réponse succès (200):
// { execution_id: string, status: "running", accounts_count: number }
//
// Réponses erreur:
// 400 { error: "execution_id manquant" }
// 403 { error: "org mismatch" }
// 404 { error: "exécution introuvable" }
// 409 { error: "statut invalide" }  — not in pending_approval state

async function handleApproveExecution(
  supabase: SupabaseClient,
  playbookId: string,
  req: Request,
  authOrgId: string,
): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  const executionId = body.execution_id as string | undefined
  if (!executionId) {
    return errorResponse('execution_id manquant', 400)
  }

  // Fetch execution scoped by org_id (cross-tenant prevention)
  const { data: execution, error: fetchError } = await supabase
    .from('playbook_executions')
    .select('id, execution_status, execution_log, playbook_id, organization_id, accounts_targeted')
    .eq('id', executionId)
    .eq('organization_id', authOrgId)
    .maybeSingle()

  if (fetchError || !execution) {
    return errorResponse('exécution introuvable', 404)
  }

  // Verify playbook_id matches the URL parameter
  if (execution.playbook_id !== playbookId) {
    return errorResponse('exécution introuvable', 404)
  }

  if (!canApprove(execution)) {
    return errorResponse('statut invalide', 409)
  }

  // Transition to running
  await supabase
    .from('playbook_executions')
    .update({ execution_status: 'running' })
    .eq('id', executionId)

  // Read stored context from execution_log
  const log = (execution.execution_log ?? {}) as Record<string, unknown>
  const accountIds = (log.account_ids ?? []) as string[]
  const plannedActions = (log.planned_actions ?? []) as PlaybookAction[]

  // Fetch accounts for action dispatch
  let accountsCount = 0
  if (accountIds.length > 0 && plannedActions.length > 0) {
    const { data: accounts } = await supabase
      .from('accounts')
      .select('id, organization_id, stripe_customer_id, hubspot_company_id, health_score, churn_risk_score, expansion_score, product_usage_score, mrr_cents, arr_cents, plan_tier, seat_count, seat_limit, contract_start_date, contract_end_date, created_at')
      .eq('organization_id', authOrgId)
      .in('id', accountIds)

    const targetAccounts = accounts ?? []
    accountsCount = targetAccounts.length

    // Execute actions for each account (reuse standard action dispatch)
    const allResults: ActionResult[] = []
    let totalCompleted = 0
    let totalFailed = 0

    for (const account of targetAccounts) {
      const acc = account as AccountData
      for (const action of plannedActions) {
        const result = executeAction(action, acc, {
          playbookId,
          executionId,
        })
        allResults.push(result)
        if (result.status === 'completed') totalCompleted++
        else if (result.status === 'failed') totalFailed++
      }
    }

    // Determine final status
    let finalStatus: string
    if (totalFailed === 0) finalStatus = 'completed'
    else if (totalCompleted === 0) finalStatus = 'failed'
    else finalStatus = 'partially_completed'

    await supabase
      .from('playbook_executions')
      .update({
        execution_status: finalStatus,
        actions_completed: allResults,
        completed_at: new Date().toISOString(),
        accounts_reached: targetAccounts.length,
      })
      .eq('id', executionId)
  } else {
    // No accounts or actions — mark completed
    accountsCount = 0
    await supabase
      .from('playbook_executions')
      .update({
        execution_status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', executionId)
  }

  return jsonResponse({
    execution_id: executionId,
    status: 'running',
    accounts_count: accountsCount,
  })
}

// ── REJECT EXECUTION ────────────────────────────────────────
// POST /functions/v1/playbook-crud/{id}/reject-execution
// Authorization: Bearer <supabase_jwt>
//
// Body: { execution_id: string, reason?: string }
//
// Réponse succès (200):
// { execution_id: string, status: "cancelled" }
//
// Réponses erreur:
// 400 { error: "execution_id manquant" }
// 403 { error: "playbook_id ne correspond pas à cette exécution" }
// 404 { error: "exécution introuvable" }
// 409 { error: "statut invalide" }

async function handleRejectExecution(
  supabase: SupabaseClient,
  playbookId: string,
  req: Request,
  authOrgId: string,
): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  const executionId = body.execution_id as string | undefined
  if (!executionId) {
    return errorResponse('execution_id manquant', 400)
  }

  // Fetch execution scoped by org_id (cross-tenant prevention)
  const { data: execution, error: fetchError } = await supabase
    .from('playbook_executions')
    .select('id, execution_status, execution_log, playbook_id, organization_id')
    .eq('id', executionId)
    .eq('organization_id', authOrgId)
    .maybeSingle()

  if (fetchError || !execution) {
    return errorResponse('exécution introuvable', 404)
  }

  // Verify playbook_id matches the URL parameter (symmetric with handleApproveExecution)
  if (!isPlaybookMatch(execution, playbookId)) {
    return errorResponse('playbook_id ne correspond pas à cette exécution', 403)
  }

  if (!canReject(execution)) {
    return errorResponse('statut invalide', 409)
  }

  const reason = (body.reason as string) ?? undefined
  const updatedLog = buildApprovalLog(execution.execution_log, reason)

  await supabase
    .from('playbook_executions')
    .update({
      execution_status: 'cancelled',
      execution_log: updatedLog,
      completed_at: new Date().toISOString(),
    })
    .eq('id', executionId)

  return jsonResponse({
    execution_id: executionId,
    status: 'cancelled',
  })
}
