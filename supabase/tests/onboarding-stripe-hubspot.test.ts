import { describe, it, expect } from 'vitest'

// ── Miroirs des fonctions pures exportées ─────────────────────

function validateStripeKeyFormat(key: string): { valid: boolean; mode: 'live' | 'test' } {
  const VALID_PREFIXES = ['rk_live_', 'rk_test_', 'sk_live_', 'sk_test_']
  const MIN_SUFFIX_LENGTH = 20
  for (const prefix of VALID_PREFIXES) {
    if (key.startsWith(prefix) && key.length >= prefix.length + MIN_SUFFIX_LENGTH) {
      const mode = prefix.includes('live') ? 'live' : 'test'
      return { valid: true, mode }
    }
  }
  return { valid: false, mode: 'test' }
}

function validateHubSpotKeyFormat(key: string): boolean {
  return typeof key === 'string' && key.startsWith('pat-')
}

function maskStripeId(id: string): string {
  if (!id || id.length < 3) return 'cus_***'
  return 'cus_***' + id.slice(-3)
}

type SyncStatus = 'pending' | 'running' | 'completed' | 'error'

function deriveSyncStatus(sync: {
  sync_status: string
  started_at: string | null
  completed_at: string | null
  error_message: string | null
} | null): SyncStatus {
  if (!sync) return 'pending'
  if (sync.error_message) return 'error'
  if (sync.completed_at) return 'completed'
  if (sync.started_at) return 'running'
  return 'pending'
}

// ── Tests validateStripeKeyFormat ─────────────────────────────

describe('validateStripeKeyFormat', () => {
  const makeSuffix = (n: number) => 'a'.repeat(n)

  it('accepte rk_live_ avec 20+ chars de suffixe → mode live', () => {
    const result = validateStripeKeyFormat(`rk_live_${makeSuffix(20)}`)
    expect(result.valid).toBe(true)
    expect(result.mode).toBe('live')
  })

  it('accepte rk_test_ avec 20+ chars de suffixe → mode test', () => {
    const result = validateStripeKeyFormat(`rk_test_${makeSuffix(20)}`)
    expect(result.valid).toBe(true)
    expect(result.mode).toBe('test')
  })

  it('accepte sk_live_ avec 20+ chars de suffixe → mode live', () => {
    const result = validateStripeKeyFormat(`sk_live_${makeSuffix(20)}`)
    expect(result.valid).toBe(true)
    expect(result.mode).toBe('live')
  })

  it('accepte sk_test_ avec 20+ chars de suffixe → mode test', () => {
    const result = validateStripeKeyFormat(`sk_test_${makeSuffix(20)}`)
    expect(result.valid).toBe(true)
    expect(result.mode).toBe('test')
  })

  it('rejette rk_live_ avec suffixe trop court (19 chars)', () => {
    const result = validateStripeKeyFormat(`rk_live_${makeSuffix(19)}`)
    expect(result.valid).toBe(false)
  })

  it('rejette une clé sans préfixe valide', () => {
    const result = validateStripeKeyFormat(`pk_live_${makeSuffix(20)}`)
    expect(result.valid).toBe(false)
  })

  it('rejette une chaîne vide', () => {
    expect(validateStripeKeyFormat('').valid).toBe(false)
  })

  it('rejette une clé arbitraire', () => {
    expect(validateStripeKeyFormat('not-a-stripe-key').valid).toBe(false)
  })
})

// ── Tests validateHubSpotKeyFormat ───────────────────────────

describe('validateHubSpotKeyFormat', () => {
  it('accepte un token commençant par pat-', () => {
    expect(validateHubSpotKeyFormat('pat-eu1-abc123')).toBe(true)
  })

  it('rejette un token sans préfixe pat-', () => {
    expect(validateHubSpotKeyFormat('Bearer abc123')).toBe(false)
  })

  it('rejette une chaîne vide', () => {
    expect(validateHubSpotKeyFormat('')).toBe(false)
  })

  it('rejette un token HubSpot v1 (sans pat-)', () => {
    expect(validateHubSpotKeyFormat('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')).toBe(false)
  })
})

// ── Tests maskStripeId ────────────────────────────────────────

describe('maskStripeId', () => {
  it('masque un stripe_customer_id standard', () => {
    expect(maskStripeId('cus_abc123xyz')).toBe('cus_***xyz')
  })

  it('conserve exactement les 3 derniers caractères', () => {
    expect(maskStripeId('cus_ABCDEFGHI')).toBe('cus_***GHI')
  })

  it('retourne cus_*** pour une chaîne trop courte', () => {
    expect(maskStripeId('ab')).toBe('cus_***')
  })

  it('retourne cus_*** pour une chaîne vide', () => {
    expect(maskStripeId('')).toBe('cus_***')
  })

  it('ne contient jamais le début de l\'ID original', () => {
    const masked = maskStripeId('cus_SENSITIVE_DATA_xyz')
    expect(masked).not.toContain('SENSITIVE')
    expect(masked).toContain('xyz')
  })
})

// ── Tests deriveSyncStatus ────────────────────────────────────

describe('deriveSyncStatus', () => {
  it('retourne pending si aucun sync trouvé', () => {
    expect(deriveSyncStatus(null)).toBe('pending')
  })

  it('retourne running si started_at présent, pas completed_at', () => {
    expect(deriveSyncStatus({
      sync_status: 'running',
      started_at: '2026-05-24T10:00:00Z',
      completed_at: null,
      error_message: null,
    })).toBe('running')
  })

  it('retourne completed si completed_at présent et pas d\'erreur', () => {
    expect(deriveSyncStatus({
      sync_status: 'completed',
      started_at: '2026-05-24T10:00:00Z',
      completed_at: '2026-05-24T10:01:00Z',
      error_message: null,
    })).toBe('completed')
  })

  it('retourne error si error_message présent (prioritaire sur completed_at)', () => {
    expect(deriveSyncStatus({
      sync_status: 'error',
      started_at: '2026-05-24T10:00:00Z',
      completed_at: '2026-05-24T10:01:00Z',
      error_message: 'Stripe API timeout',
    })).toBe('error')
  })

  it('retourne pending si started_at null et pas d\'erreur', () => {
    expect(deriveSyncStatus({
      sync_status: 'pending',
      started_at: null,
      completed_at: null,
      error_message: null,
    })).toBe('pending')
  })
})
