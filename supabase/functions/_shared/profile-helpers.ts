// ============================================================
// Profile helpers — Pure functions for profile/invitation logic
// No Deno/jsr imports — testable with Vitest
// ============================================================

export interface Invitation {
  id: string
  organization_id: string
  role: string
  email: string
  accepted_at: string | null
  expires_at: string
  created_at: string
}

export interface ProfileCandidate {
  auth_user_id: string
  email: string
  organization_id: string | null
  role: string
}

/**
 * Finds the best matching invitation for a given email.
 * Returns the most recent valid (non-expired, non-accepted) invitation, or null.
 */
export function findValidInvitation(
  invitations: Invitation[],
  email: string,
  now: Date = new Date(),
): Invitation | null {
  const normalizedEmail = email.toLowerCase().trim()
  const nowMs = now.getTime()

  const valid = invitations
    .filter(
      (inv) =>
        inv.email.toLowerCase().trim() === normalizedEmail &&
        inv.accepted_at === null &&
        new Date(inv.expires_at).getTime() > nowMs,
    )
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  return valid.length > 0 ? valid[0] : null
}

/**
 * Builds a ProfileCandidate from auth user data and an optional invitation.
 */
export function buildProfileCandidate(
  authUserId: string,
  email: string,
  invitation: Invitation | null,
): ProfileCandidate {
  return {
    auth_user_id: authUserId,
    email,
    organization_id: invitation?.organization_id ?? null,
    role: invitation?.role ?? 'member',
  }
}
