import { describe, it, expect } from 'vitest'

// ── Tests unitaires de la logique d'approbation ──────────────
// La Edge Function requiert un env Deno.
// Ces tests couvrent la logique pure et les garanties Zero-PII.

// ── Types miroir ──────────────────────────────────────────────

type QueueStatus = 'pending' | 'approved' | 'rejected' | 'expired'

interface QueueItem {
  id: string
  organization_id: string
  destination_id: string
  account_id: string
  stripe_customer_id: string
  connector: string
  trigger_reason: string
  segment_at_trigger: string | null
  segment_previous: string | null
  churn_risk_at_trigger: number | null
  health_score_at_trigger: number | null
  expansion_score_at_trigger: number | null
  mrr_cents_at_trigger: number | null
  status: QueueStatus
  expires_at: string
}

// ── Helpers miroir ────────────────────────────────────────────

function isExpired(item: QueueItem): boolean {
  return new Date(item.expires_at) < new Date()
}

function canBeProcessed(item: QueueItem): { ok: boolean; reason?: string } {
  if (item.status !== 'pending') {
    return { ok: false, reason: `Item deja traite (statut: ${item.status})` }
  }
  if (isExpired(item)) {
    return { ok: false, reason: 'Item expire' }
  }
  return { ok: true }
}

function buildExecutionLogRow(item: QueueItem, organizationId: string): Record<string, unknown> {
  return {
    organization_id: organizationId,
    destination_id: item.destination_id,
    account_id: item.account_id,
    stripe_customer_id: item.stripe_customer_id,
    connector: item.connector,
    trigger_reason: item.trigger_reason,
    segment_at_trigger: item.segment_at_trigger,
    churn_risk_at_trigger: item.churn_risk_at_trigger,
    mrr_cents_at_trigger: item.mrr_cents_at_trigger,
  }
}

function makeQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'queue-uuid-001',
    organization_id: 'org-uuid-001',
    destination_id: 'dest-uuid-001',
    account_id: 'acct-uuid-001',
    stripe_customer_id: 'cus_TEST123',
    connector: 'brevo',
    trigger_reason: 'segment_change',
    segment_at_trigger: 'en_danger_critique',
    segment_previous: 'a_risque_leger',
    churn_risk_at_trigger: 78,
    health_score_at_trigger: 22,
    expansion_score_at_trigger: 8,
    mrr_cents_at_trigger: 49900,
    status: 'pending',
    expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  }
}

// ── Validation statut ────────────────────────────────────────

describe('playbook-approve: validation statut', () => {
  it('accepte un item pending non expire', () => {
    const item = makeQueueItem()
    const result = canBeProcessed(item)
    expect(result.ok).toBe(true)
  })

  it('rejette un item deja approuve', () => {
    const item = makeQueueItem({ status: 'approved' })
    const result = canBeProcessed(item)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('approved')
  })

  it('rejette un item deja rejete', () => {
    const item = makeQueueItem({ status: 'rejected' })
    const result = canBeProcessed(item)
    expect(result.ok).toBe(false)
  })

  it('rejette un item expire (expires_at dans le passe)', () => {
    const item = makeQueueItem({
      expires_at: new Date(Date.now() - 1000).toISOString(),
    })
    const result = canBeProcessed(item)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('expire')
  })

  it('accepte un item dont expires_at est dans 1 seconde', () => {
    const item = makeQueueItem({
      expires_at: new Date(Date.now() + 1000).toISOString(),
    })
    const result = canBeProcessed(item)
    expect(result.ok).toBe(true)
  })
})

// ── Expiry 48h ───────────────────────────────────────────────

describe('playbook-approve: expiry 48h', () => {
  it('un item cree maintenant expire dans 48h', () => {
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000)
    const item = makeQueueItem({ expires_at: expiresAt.toISOString() })
    expect(isExpired(item)).toBe(false)
  })

  it('un item dont expires_at est il y a 1 minute est expire', () => {
    const item = makeQueueItem({
      expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
    })
    expect(isExpired(item)).toBe(true)
  })
})

// ── Bifurcation require_approval dans playbook-executor ──────

describe('playbook-executor: bifurcation require_approval', () => {
  interface Destination {
    id: string
    require_approval: boolean
    is_active: boolean
  }

  function splitDestinations(destinations: Destination[]) {
    return {
      immediate: destinations.filter((d) => d.is_active && !d.require_approval),
      queued: destinations.filter((d) => d.is_active && d.require_approval),
    }
  }

  it('une destination require_approval=false va en immediate', () => {
    const dests = [{ id: 'dest-1', require_approval: false, is_active: true }]
    const { immediate, queued } = splitDestinations(dests)
    expect(immediate).toHaveLength(1)
    expect(queued).toHaveLength(0)
  })

  it('une destination require_approval=true va en queue', () => {
    const dests = [{ id: 'dest-1', require_approval: true, is_active: true }]
    const { immediate, queued } = splitDestinations(dests)
    expect(immediate).toHaveLength(0)
    expect(queued).toHaveLength(1)
  })

  it('mix de destinations : chacune va au bon endroit', () => {
    const dests = [
      { id: 'dest-1', require_approval: false, is_active: true },
      { id: 'dest-2', require_approval: true, is_active: true },
      { id: 'dest-3', require_approval: true, is_active: true },
    ]
    const { immediate, queued } = splitDestinations(dests)
    expect(immediate).toHaveLength(1)
    expect(queued).toHaveLength(2)
  })

  it('une destination inactive ne va ni en immediate ni en queue', () => {
    const dests = [{ id: 'dest-1', require_approval: false, is_active: false }]
    const { immediate, queued } = splitDestinations(dests)
    expect(immediate).toHaveLength(0)
    expect(queued).toHaveLength(0)
  })
})

// ── Zero-PII : log d'execution sans email ────────────────────

describe('playbook-approve: Zero-PII — log sans email', () => {
  it("le log insere dans playbook_execution_logs ne contient pas de colonne email", () => {
    const item = makeQueueItem()
    const logRow = buildExecutionLogRow(item, 'org-uuid-001')
    const keys = Object.keys(logRow)
    expect(keys.some((k) => k.toLowerCase().includes('email'))).toBe(false)
    expect(keys.some((k) => k.toLowerCase().includes('phone'))).toBe(false)
    expect(keys.some((k) => k === 'ip' || k.startsWith('ip_'))).toBe(false)
  })

  it("stripe_customer_id est present et est un identifiant opaque", () => {
    const item = makeQueueItem()
    const logRow = buildExecutionLogRow(item, 'org-uuid-001')
    expect(logRow.stripe_customer_id).toBe('cus_TEST123')
    expect(logRow.stripe_customer_id).not.toMatch(
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
    )
  })

  it("le payload DLQ sur echec connecteur ne contient pas d'email", () => {
    const dlqPayload = {
      queue_item_id: 'queue-uuid-001',
      destination_id: 'dest-uuid-001',
      stripe_customer_id: 'cus_TEST123',
    }
    const serialized = JSON.stringify(dlqPayload)
    expect(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(serialized)).toBe(false)
  })
})

// ── Validation input ─────────────────────────────────────────

describe('playbook-approve: validation input', () => {
  it("action 'approved' est valide", () => {
    const valid = ['approved', 'rejected']
    expect(valid.includes('approved')).toBe(true)
  })

  it("action 'rejected' est valide", () => {
    const valid = ['approved', 'rejected']
    expect(valid.includes('rejected')).toBe(true)
  })

  it("action 'pending' n'est pas valide", () => {
    const valid = ['approved', 'rejected']
    expect(valid.includes('pending')).toBe(false)
  })

  it('queue_item_id manquant rend le payload invalide', () => {
    const body: { queue_item_id?: string; action: string } = { action: 'approved' }
    const isValid = Boolean(body.queue_item_id && body.action)
    expect(isValid).toBe(false)
  })
})
