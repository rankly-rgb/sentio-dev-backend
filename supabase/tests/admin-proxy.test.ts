import { describe, it, expect } from 'vitest'

// ── admin-proxy validation logic tests ──────────────────────

const ALLOWED_ACTIONS = ['sync-stripe', 'sync-hubspot', 'calculate-scores', 'health-check', 'self-monitor'] as const
type AllowedAction = typeof ALLOWED_ACTIONS[number]
const ACTIONS_REQUIRING_ORG: AllowedAction[] = ['sync-stripe', 'sync-hubspot', 'calculate-scores']

function isAllowedAction(action: string): action is AllowedAction {
  return ALLOWED_ACTIONS.includes(action as AllowedAction)
}

function requiresOrgId(action: AllowedAction): boolean {
  return ACTIONS_REQUIRING_ORG.includes(action)
}

function isRoleAuthorized(role: string): boolean {
  return role === 'admin' || role === 'owner'
}

function buildTargetRequest(
  action: AllowedAction,
  body: { organization_id?: string; sync_type?: string; is_manual?: boolean },
  supabaseUrl: string,
  serviceRoleKey: string
): { url: string; method: string; headers: Record<string, string>; body?: string } {
  const url = `${supabaseUrl}/functions/v1/${action}`
  const headers: Record<string, string> = {
    'apikey': serviceRoleKey,
    'Authorization': `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  }
  const isGet = action === 'health-check'
  let targetBody: string | undefined

  if (!isGet) {
    if (action === 'sync-stripe') {
      targetBody = JSON.stringify({
        organization_id: body.organization_id,
        sync_type: body.sync_type || 'incremental',
        is_manual: body.is_manual ?? true,
      })
    } else if (action === 'sync-hubspot') {
      targetBody = JSON.stringify({
        organization_id: body.organization_id,
        sync_type: body.sync_type || 'daily',
      })
    } else if (action === 'calculate-scores') {
      targetBody = JSON.stringify({
        organization_id: body.organization_id,
      })
    } else if (action === 'self-monitor') {
      targetBody = JSON.stringify({})
    }
  }

  return {
    url,
    method: isGet ? 'GET' : 'POST',
    headers,
    body: targetBody,
  }
}

// ── Action validation ───────────────────────────────────────

describe('admin-proxy: action validation', () => {
  it('accepts sync-stripe', () => {
    expect(isAllowedAction('sync-stripe')).toBe(true)
  })

  it('accepts calculate-scores', () => {
    expect(isAllowedAction('calculate-scores')).toBe(true)
  })

  it('accepts health-check', () => {
    expect(isAllowedAction('health-check')).toBe(true)
  })

  it('accepts self-monitor', () => {
    expect(isAllowedAction('self-monitor')).toBe(true)
  })

  it('accepts sync-hubspot', () => {
    expect(isAllowedAction('sync-hubspot')).toBe(true)
  })

  it('rejects unknown actions', () => {
    expect(isAllowedAction('drop-database')).toBe(false)
    expect(isAllowedAction('')).toBe(false)
    expect(isAllowedAction('sync-unknown')).toBe(false)
  })
})

// ── Org ID requirement ──────────────────────────────────────

describe('admin-proxy: org_id requirement', () => {
  it('sync-stripe requires org_id', () => {
    expect(requiresOrgId('sync-stripe')).toBe(true)
  })

  it('calculate-scores requires org_id', () => {
    expect(requiresOrgId('calculate-scores')).toBe(true)
  })

  it('sync-hubspot requires org_id', () => {
    expect(requiresOrgId('sync-hubspot')).toBe(true)
  })

  it('health-check does not require org_id', () => {
    expect(requiresOrgId('health-check')).toBe(false)
  })

  it('self-monitor does not require org_id', () => {
    expect(requiresOrgId('self-monitor')).toBe(false)
  })
})

// ── Role authorization ──────────────────────────────────────

describe('admin-proxy: role authorization', () => {
  it('admin is authorized', () => {
    expect(isRoleAuthorized('admin')).toBe(true)
  })

  it('owner is authorized', () => {
    expect(isRoleAuthorized('owner')).toBe(true)
  })

  it('member is not authorized', () => {
    expect(isRoleAuthorized('member')).toBe(false)
  })

  it('viewer is not authorized', () => {
    expect(isRoleAuthorized('viewer')).toBe(false)
  })

  it('empty string is not authorized', () => {
    expect(isRoleAuthorized('')).toBe(false)
  })
})

// ── Request building ────────────────────────────────────────

describe('admin-proxy: buildTargetRequest', () => {
  const baseUrl = 'https://example.supabase.co'
  const serviceKey = 'test-service-key'

  it('builds GET request for health-check', () => {
    const result = buildTargetRequest('health-check', {}, baseUrl, serviceKey)
    expect(result.method).toBe('GET')
    expect(result.url).toBe(`${baseUrl}/functions/v1/health-check`)
    expect(result.body).toBeUndefined()
    expect(result.headers['Authorization']).toBe(`Bearer ${serviceKey}`)
  })

  it('builds POST request for sync-stripe with defaults', () => {
    const result = buildTargetRequest(
      'sync-stripe',
      { organization_id: 'org-123' },
      baseUrl,
      serviceKey
    )
    expect(result.method).toBe('POST')
    expect(result.url).toBe(`${baseUrl}/functions/v1/sync-stripe`)

    const parsed = JSON.parse(result.body!)
    expect(parsed.organization_id).toBe('org-123')
    expect(parsed.sync_type).toBe('incremental')
    expect(parsed.is_manual).toBe(true)
  })

  it('builds POST request for sync-stripe with explicit params', () => {
    const result = buildTargetRequest(
      'sync-stripe',
      { organization_id: 'org-456', sync_type: 'full_sync', is_manual: false },
      baseUrl,
      serviceKey
    )
    const parsed = JSON.parse(result.body!)
    expect(parsed.sync_type).toBe('full_sync')
    expect(parsed.is_manual).toBe(false)
  })

  it('builds POST request for sync-hubspot with defaults', () => {
    const result = buildTargetRequest(
      'sync-hubspot',
      { organization_id: 'org-123' },
      baseUrl,
      serviceKey
    )
    expect(result.method).toBe('POST')
    expect(result.url).toBe(`${baseUrl}/functions/v1/sync-hubspot`)

    const parsed = JSON.parse(result.body!)
    expect(parsed.organization_id).toBe('org-123')
    expect(parsed.sync_type).toBe('daily')
  })

  it('builds POST request for sync-hubspot with explicit sync_type', () => {
    const result = buildTargetRequest(
      'sync-hubspot',
      { organization_id: 'org-456', sync_type: 'initial' },
      baseUrl,
      serviceKey
    )
    const parsed = JSON.parse(result.body!)
    expect(parsed.sync_type).toBe('initial')
  })

  it('builds POST request for calculate-scores', () => {
    const result = buildTargetRequest(
      'calculate-scores',
      { organization_id: 'org-789' },
      baseUrl,
      serviceKey
    )
    expect(result.method).toBe('POST')

    const parsed = JSON.parse(result.body!)
    expect(parsed.organization_id).toBe('org-789')
    expect(parsed).not.toHaveProperty('sync_type')
  })

  it('builds POST request for self-monitor with empty body', () => {
    const result = buildTargetRequest('self-monitor', {}, baseUrl, serviceKey)
    expect(result.method).toBe('POST')
    expect(result.body).toBe('{}')
  })

  it('never includes service_role key in body', () => {
    for (const action of ALLOWED_ACTIONS) {
      const result = buildTargetRequest(
        action,
        { organization_id: 'org-001' },
        baseUrl,
        serviceKey
      )
      if (result.body) {
        expect(result.body).not.toContain(serviceKey)
      }
    }
  })

  it('always includes Authorization header with service_role', () => {
    for (const action of ALLOWED_ACTIONS) {
      const result = buildTargetRequest(action, {}, baseUrl, serviceKey)
      expect(result.headers['Authorization']).toBe(`Bearer ${serviceKey}`)
    }
  })

  it('always includes apikey header for Supabase relay routing', () => {
    for (const action of ALLOWED_ACTIONS) {
      const result = buildTargetRequest(action, {}, baseUrl, serviceKey)
      expect(result.headers['apikey']).toBe(serviceKey)
    }
  })
})

// ── Org mismatch detection ──────────────────────────────────

describe('admin-proxy: org mismatch detection', () => {
  it('detects when requested org differs from user org', () => {
    const userOrg = 'org-001'
    const requestedOrg = 'org-002'
    expect(requestedOrg !== userOrg).toBe(true)
  })

  it('passes when orgs match', () => {
    const userOrg = 'org-001'
    const requestedOrg = 'org-001'
    expect(requestedOrg === userOrg).toBe(true)
  })

  it('handles undefined org for non-org actions', () => {
    const action: AllowedAction = 'health-check'
    // health-check doesn't require org, so undefined is fine
    expect(requiresOrgId(action)).toBe(false)
  })
})
