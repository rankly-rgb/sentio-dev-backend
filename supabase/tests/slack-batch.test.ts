import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  formatMrrEur,
  buildAccountLink,
  buildSingleAlertMessage,
  buildDigestMessage,
  type ChurnAlert,
} from '../functions/_shared/slack-batch-helpers'

// ── Test fixtures ────────────────────────────────────────────

const ALERT_HIGH_MRR: ChurnAlert = {
  account_id: 'acc-001',
  stripe_customer_id: 'cus_HIGH',
  churn_risk: 85,
  mrr_cents: 100000,
  trigger_reason: 'churn_risk 60 → 85 (seuil 70)',
}

const ALERT_MED_MRR: ChurnAlert = {
  account_id: 'acc-002',
  stripe_customer_id: 'cus_MED',
  churn_risk: 72,
  mrr_cents: 49900,
  trigger_reason: 'churn_risk 65 → 72 (seuil 70)',
}

const ALERT_LOW_MRR: ChurnAlert = {
  account_id: 'acc-003',
  stripe_customer_id: 'cus_LOW',
  churn_risk: 91,
  mrr_cents: 9900,
  trigger_reason: 'churn_risk 55 → 91 (seuil 70)',
}

const FRONTEND_URL = 'https://app.sentio.ai'

// ── formatMrrEur ─────────────────────────────────────────────

describe('formatMrrEur', () => {
  it('converts cents to EUR string (no decimals)', () => {
    expect(formatMrrEur(49900)).toBe('499')
    expect(formatMrrEur(100000)).toBe('1000')
    expect(formatMrrEur(0)).toBe('0')
    expect(formatMrrEur(9900)).toBe('99')
  })
})

// ── buildAccountLink ─────────────────────────────────────────

describe('buildAccountLink', () => {
  it('builds the correct URL for a known account', () => {
    expect(buildAccountLink(FRONTEND_URL, 'acc-001')).toBe(
      'https://app.sentio.ai/dashboard/accounts/acc-001'
    )
  })

  it('returns empty string when frontendUrl is empty', () => {
    expect(buildAccountLink('', 'acc-001')).toBe('')
  })
})

// ── buildSingleAlertMessage ──────────────────────────────────

describe('buildSingleAlertMessage', () => {
  it('contains stripe_customer_id (Zero-PII: no email/name)', () => {
    const msg = buildSingleAlertMessage(ALERT_HIGH_MRR, FRONTEND_URL)
    expect(msg).toContain('cus_HIGH')
    expect(msg).not.toMatch(/\b[\w.-]+@[\w.-]+\.\w+\b/) // no email pattern
  })

  it('contains churn risk percentage', () => {
    const msg = buildSingleAlertMessage(ALERT_HIGH_MRR, FRONTEND_URL)
    expect(msg).toContain('Churn: 85%')
  })

  it('contains MRR in EUR', () => {
    const msg = buildSingleAlertMessage(ALERT_HIGH_MRR, FRONTEND_URL)
    expect(msg).toContain('MRR: 1000€')
  })

  it('contains trigger_reason', () => {
    const msg = buildSingleAlertMessage(ALERT_HIGH_MRR, FRONTEND_URL)
    expect(msg).toContain('churn_risk 60 → 85 (seuil 70)')
  })

  it('contains the account link when frontendUrl is set', () => {
    const msg = buildSingleAlertMessage(ALERT_HIGH_MRR, FRONTEND_URL)
    expect(msg).toContain('https://app.sentio.ai/dashboard/accounts/acc-001')
  })

  it('omits link when frontendUrl is empty', () => {
    const msg = buildSingleAlertMessage(ALERT_HIGH_MRR, '')
    expect(msg).not.toContain('/dashboard/accounts/')
  })
})

// ── buildDigestMessage ───────────────────────────────────────

describe('buildDigestMessage', () => {
  it('shows N count in header for multiple alerts', () => {
    const msg = buildDigestMessage([ALERT_HIGH_MRR, ALERT_MED_MRR, ALERT_LOW_MRR], FRONTEND_URL)
    expect(msg).toContain('3 comptes en danger critique')
  })

  it('sorts entries by mrr_cents DESC (highest first)', () => {
    const msg = buildDigestMessage([ALERT_LOW_MRR, ALERT_HIGH_MRR, ALERT_MED_MRR], FRONTEND_URL)
    const posHigh = msg.indexOf('cus_HIGH')
    const posMed = msg.indexOf('cus_MED')
    const posLow = msg.indexOf('cus_LOW')
    expect(posHigh).toBeLessThan(posMed)
    expect(posMed).toBeLessThan(posLow)
  })

  it('contains all 3 stripe_customer_ids in 3-alert digest', () => {
    const msg = buildDigestMessage([ALERT_HIGH_MRR, ALERT_MED_MRR, ALERT_LOW_MRR], FRONTEND_URL)
    expect(msg).toContain('cus_HIGH')
    expect(msg).toContain('cus_MED')
    expect(msg).toContain('cus_LOW')
  })

  it('truncates to maxItems and adds "autres comptes" line for 15 alerts', () => {
    const alerts: ChurnAlert[] = Array.from({ length: 15 }, (_, i) => ({
      account_id: `acc-${i}`,
      stripe_customer_id: `cus_${i.toString().padStart(3, '0')}`,
      churn_risk: 70 + i,
      mrr_cents: (15 - i) * 10000,
      trigger_reason: `reason ${i}`,
    }))

    const msg = buildDigestMessage(alerts, FRONTEND_URL, 10)
    expect(msg).toContain('15 comptes en danger critique')
    expect(msg).toContain('et 5 autres comptes')

    // Only 10 bullet points should appear
    const bulletCount = (msg.match(/^•/gm) ?? []).length
    expect(bulletCount).toBe(10)
  })

  it('does not add "autres" line when all items fit within maxItems', () => {
    const msg = buildDigestMessage([ALERT_HIGH_MRR, ALERT_MED_MRR], FRONTEND_URL, 10)
    expect(msg).not.toContain('autres comptes')
  })

  it('does not mutate the original alerts array (sort is safe)', () => {
    const alerts = [ALERT_LOW_MRR, ALERT_HIGH_MRR, ALERT_MED_MRR]
    const original = alerts.map((a) => a.stripe_customer_id)
    buildDigestMessage(alerts, FRONTEND_URL)
    const after = alerts.map((a) => a.stripe_customer_id)
    expect(after).toEqual(original)
  })
})

// ── alertSlackBatch integration (via globalThis stubbing) ────

describe('alertSlackBatch — integration', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // Stub Deno global (not available in Node/Vitest)
    fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('Deno', {
      env: {
        get: (key: string) => {
          if (key === 'SLACK_WEBHOOK_URL') return 'https://hooks.slack.com/test'
          if (key === 'FRONTEND_URL') return 'https://app.sentio.ai'
          return undefined
        },
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('makes no HTTP call when alerts array is empty', async () => {
    // Import dynamically after stubs are in place
    const { alertSlackBatch } = await import('../functions/_shared/slack-alert')
    await alertSlackBatch([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends a simple message (not digest) for exactly 1 alert', async () => {
    const { alertSlackBatch } = await import('../functions/_shared/slack-alert')
    await alertSlackBatch([ALERT_HIGH_MRR])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    // Simple message contains stripe_customer_id directly (not as a bullet point)
    expect(body.text).toContain('cus_HIGH')
    expect(body.text).toContain('Compte en danger critique')
    // Should NOT be a digest header format
    expect(body.text).not.toContain('comptes en danger critique')
  })

  it('sends one digest message for 3 alerts', async () => {
    const { alertSlackBatch } = await import('../functions/_shared/slack-alert')
    await alertSlackBatch([ALERT_HIGH_MRR, ALERT_MED_MRR, ALERT_LOW_MRR])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.text).toContain('3 comptes en danger critique')
    expect(body.text).toContain('cus_HIGH')
    expect(body.text).toContain('cus_MED')
    expect(body.text).toContain('cus_LOW')
  })

  it('sends top 10 + "5 autres" text for 15 alerts', async () => {
    const alerts: ChurnAlert[] = Array.from({ length: 15 }, (_, i) => ({
      account_id: `acc-${i}`,
      stripe_customer_id: `cus_${i.toString().padStart(3, '0')}`,
      churn_risk: 70 + i,
      mrr_cents: (15 - i) * 10000,
      trigger_reason: `reason ${i}`,
    }))
    const { alertSlackBatch } = await import('../functions/_shared/slack-alert')
    await alertSlackBatch(alerts)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.text).toContain('15 comptes en danger critique')
    expect(body.text).toContain('et 5 autres comptes')
  })

  it('digest is sorted by mrr_cents desc (highest MRR first)', async () => {
    const { alertSlackBatch } = await import('../functions/_shared/slack-alert')
    await alertSlackBatch([ALERT_LOW_MRR, ALERT_HIGH_MRR, ALERT_MED_MRR])
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    const text: string = body.text
    const posHigh = text.indexOf('cus_HIGH')
    const posMed = text.indexOf('cus_MED')
    const posLow = text.indexOf('cus_LOW')
    expect(posHigh).toBeLessThan(posMed)
    expect(posMed).toBeLessThan(posLow)
  })
})
