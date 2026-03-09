import { describe, it, expect } from 'vitest'
import {
  findValidInvitation,
  buildProfileCandidate,
  type Invitation,
} from '../functions/_shared/profile-helpers'

// ── Fixtures ────────────────────────────────────────────────

const ORG_ID = '550e8400-e29b-41d4-a716-446655440000'
const AUTH_USER_ID = '660e8400-e29b-41d4-a716-446655440001'
const NOW = new Date('2026-03-09T12:00:00Z')

function makeInvitation(overrides: Partial<Invitation> = {}): Invitation {
  return {
    id: 'inv-001',
    organization_id: ORG_ID,
    role: 'member',
    email: 'alice@example.com',
    accepted_at: null,
    expires_at: '2026-03-10T12:00:00Z', // 24h from NOW
    created_at: '2026-03-09T10:00:00Z',
    ...overrides,
  }
}

// ── findValidInvitation ─────────────────────────────────────

describe('findValidInvitation', () => {
  it('returns matching invitation when email matches and not expired/accepted', () => {
    const inv = makeInvitation()
    const result = findValidInvitation([inv], 'alice@example.com', NOW)
    expect(result).toEqual(inv)
  })

  it('returns null when no invitations exist', () => {
    const result = findValidInvitation([], 'alice@example.com', NOW)
    expect(result).toBeNull()
  })

  it('returns null when email does not match', () => {
    const inv = makeInvitation()
    const result = findValidInvitation([inv], 'bob@example.com', NOW)
    expect(result).toBeNull()
  })

  it('returns null when invitation is expired', () => {
    const inv = makeInvitation({ expires_at: '2026-03-09T11:00:00Z' }) // 1h before NOW
    const result = findValidInvitation([inv], 'alice@example.com', NOW)
    expect(result).toBeNull()
  })

  it('returns null when invitation is already accepted', () => {
    const inv = makeInvitation({ accepted_at: '2026-03-09T08:00:00Z' })
    const result = findValidInvitation([inv], 'alice@example.com', NOW)
    expect(result).toBeNull()
  })

  it('is case-insensitive on email', () => {
    const inv = makeInvitation({ email: 'Alice@Example.COM' })
    const result = findValidInvitation([inv], 'alice@example.com', NOW)
    expect(result).toEqual(inv)
  })

  it('trims whitespace from emails', () => {
    const inv = makeInvitation({ email: '  alice@example.com  ' })
    const result = findValidInvitation([inv], 'alice@example.com', NOW)
    expect(result).toEqual(inv)
  })

  it('returns the most recent invitation when multiple valid ones exist', () => {
    const older = makeInvitation({ id: 'inv-old', created_at: '2026-03-08T10:00:00Z', role: 'viewer' })
    const newer = makeInvitation({ id: 'inv-new', created_at: '2026-03-09T10:00:00Z', role: 'admin' })
    const result = findValidInvitation([older, newer], 'alice@example.com', NOW)
    expect(result?.id).toBe('inv-new')
    expect(result?.role).toBe('admin')
  })

  it('skips expired invitations and returns a valid one', () => {
    const expired = makeInvitation({ id: 'inv-expired', expires_at: '2026-03-08T00:00:00Z' })
    const valid = makeInvitation({ id: 'inv-valid' })
    const result = findValidInvitation([expired, valid], 'alice@example.com', NOW)
    expect(result?.id).toBe('inv-valid')
  })

  it('returns null when expires_at equals NOW exactly (not strictly greater)', () => {
    const inv = makeInvitation({ expires_at: '2026-03-09T12:00:00Z' }) // exactly NOW
    const result = findValidInvitation([inv], 'alice@example.com', NOW)
    expect(result).toBeNull()
  })
})

// ── buildProfileCandidate ───────────────────────────────────

describe('buildProfileCandidate', () => {
  it('builds profile with org from invitation', () => {
    const inv = makeInvitation({ role: 'admin' })
    const result = buildProfileCandidate(AUTH_USER_ID, 'alice@example.com', inv)
    expect(result).toEqual({
      auth_user_id: AUTH_USER_ID,
      email: 'alice@example.com',
      organization_id: ORG_ID,
      role: 'admin',
    })
  })

  it('builds profile with null org when no invitation', () => {
    const result = buildProfileCandidate(AUTH_USER_ID, 'bob@example.com', null)
    expect(result).toEqual({
      auth_user_id: AUTH_USER_ID,
      email: 'bob@example.com',
      organization_id: null,
      role: 'member',
    })
  })

  it('uses member as default role from invitation', () => {
    const inv = makeInvitation({ role: 'member' })
    const result = buildProfileCandidate(AUTH_USER_ID, 'alice@example.com', inv)
    expect(result.role).toBe('member')
  })

  it('preserves viewer role from invitation', () => {
    const inv = makeInvitation({ role: 'viewer' })
    const result = buildProfileCandidate(AUTH_USER_ID, 'alice@example.com', inv)
    expect(result.role).toBe('viewer')
  })
})
