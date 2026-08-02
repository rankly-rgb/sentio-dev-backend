import { describe, it, expect } from 'vitest'

// ── Mirror types (churn-alert/index.ts) ───────────────────────

interface CriticalAccount {
  id: string
  stripe_customer_id: string
  display_name: string | null
  mrr_cents: number
  churn_risk_score: number
  health_score: number | null
}

interface TriggeredSignal {
  code: string
  label: string
  severity: 'CRITIQUE' | 'MAJEUR' | 'MINEUR'
  points: number
}

interface AlertEligibilityInput {
  churnRiskBand: 'low' | 'watch' | 'high' | null
  lastChurnAlertAt: string | null
  lastAlertSignalCodes: string[] | null
  riskSignalsTriggered: TriggeredSignal[]
  now: number
}

const COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000

// ── Mirror helpers (churn-alert/index.ts — S9) ────────────────

function isEligibleForChurnAlert(input: AlertEligibilityInput): boolean {
  if (input.churnRiskBand !== 'high') return false
  if (!input.lastChurnAlertAt) return true

  const elapsed = input.now - new Date(input.lastChurnAlertAt).getTime()
  if (elapsed >= COOLDOWN_MS) return true

  const previousCodes = new Set(input.lastAlertSignalCodes ?? [])
  const hasNewCritical = input.riskSignalsTriggered.some(
    (s) => s.severity === 'CRITIQUE' && !previousCodes.has(s.code),
  )
  return hasNewCritical
}

function maskCustomerId(stripeCustomerId: string): string {
  return 'cus_***' + stripeCustomerId.slice(-3)
}

function formatAccountLabel(account: CriticalAccount): string {
  return account.display_name || maskCustomerId(account.stripe_customer_id)
}

function buildChurnAlertEmail(accounts: CriticalAccount[]): string {
  const n = accounts.length
  const rows = accounts.map(a => {
    const label = formatAccountLabel(a)
    const mrr = '$' + Math.round(a.mrr_cents / 100).toLocaleString('en-US')
    const healthLabel = a.health_score === null ? 'N/A' : `${a.health_score}/100`
    return `
    <tr>
      <td>${label}</td>
      <td>${mrr}/mo</td>
      <td>${healthLabel}</td>
      <td>${a.churn_risk_score}/100</td>
      <td><a href="https://app.sentioapp.io/dashboard/accounts/${a.id}">View →</a></td>
    </tr>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"></head>
<body>
  <h1>Churn alert</h1>
  <p><strong>${n} account${n > 1 ? 's' : ''}</strong> ${n > 1 ? 'have' : 'has'} just entered critical risk zone.</p>
  <table><thead><tr>
    <th>Account</th><th>MRR</th><th>Health</th><th>Risk</th><th>Action</th>
  </tr></thead><tbody>${rows}</tbody></table>
</body>
</html>`
}

// ── Fixtures ──────────────────────────────────────────────────

const baseAccount: CriticalAccount = {
  id: 'uuid-001',
  stripe_customer_id: 'cus_abcXYZ',
  display_name: 'Acme Corp',
  mrr_cents: 49900,
  churn_risk_score: 82,
  health_score: 18,
}

const anonymousAccount: CriticalAccount = {
  id: 'uuid-002',
  stripe_customer_id: 'cus_def456',
  display_name: null,
  mrr_cents: 9900,
  churn_risk_score: 75,
  health_score: 25,
}

// ── Tests ─────────────────────────────────────────────────────

describe('maskCustomerId', () => {
  it('returns cus_*** + last 3 chars', () => {
    expect(maskCustomerId('cus_abcXYZ')).toBe('cus_***XYZ')
  })

  it('works with a short id', () => {
    expect(maskCustomerId('cus_abc')).toBe('cus_***abc')
  })
})

describe('formatAccountLabel', () => {
  it('returns display_name when non-null', () => {
    expect(formatAccountLabel(baseAccount)).toBe('Acme Corp')
  })

  it('returns cus_***<3chars> when display_name is null', () => {
    expect(formatAccountLabel(anonymousAccount)).toBe('cus_***456')
  })
})

describe('buildChurnAlertEmail', () => {
  it('generates an email with N accounts in the subject', () => {
    const html = buildChurnAlertEmail([baseAccount, anonymousAccount])
    expect(html).toContain('2 accounts')
    expect(html).toContain('have just entered')
  })

  it('singular with 1 account', () => {
    const html = buildChurnAlertEmail([baseAccount])
    expect(html).toContain('1 account')
    expect(html).toContain('has just entered')
  })

  it('uses display_name when available', () => {
    const html = buildChurnAlertEmail([baseAccount])
    expect(html).toContain('Acme Corp')
  })

  it('masks stripe_customer_id when display_name is absent', () => {
    const html = buildChurnAlertEmail([anonymousAccount])
    expect(html).toContain('cus_***456')
    expect(html).not.toContain('cus_def456')
  })

  it('displays MRR in USD', () => {
    const html = buildChurnAlertEmail([baseAccount])
    expect(html).toContain('$499/mo')
  })

  it('displays churn_risk_score and health_score', () => {
    const html = buildChurnAlertEmail([baseAccount])
    expect(html).toContain('82/100')
    expect(html).toContain('18/100')
  })

  it('includes a link to the account', () => {
    const html = buildChurnAlertEmail([baseAccount])
    expect(html).toContain('/dashboard/accounts/uuid-001')
  })

  describe('Zero-PII', () => {
    const piiAccount: CriticalAccount = {
      id: 'uuid-003',
      stripe_customer_id: 'cus_pii789',
      display_name: null,
      mrr_cents: 19900,
      churn_risk_score: 90,
      health_score: 10,
    }

    it('does not contain an @ symbol (email)', () => {
      const html = buildChurnAlertEmail([piiAccount])
      const bodyContent = html.replace(/href="[^"]*"/g, '').replace(/action="[^"]*"/g, '')
      expect(bodyContent).not.toMatch(/@/)
    })

    it('does not contain an "email" field in the payload', () => {
      const html = buildChurnAlertEmail([piiAccount])
      expect(html.toLowerCase()).not.toContain('"email"')
    })

    it('does not contain "phone" in the payload', () => {
      const html = buildChurnAlertEmail([piiAccount])
      expect(html.toLowerCase()).not.toContain('phone')
    })

    it('does not contain "ip" as account data', () => {
      const html = buildChurnAlertEmail([piiAccount])
      expect(html).not.toMatch(/"ip"/)
    })

    it('stripe_customer_id is masked (never in clear text)', () => {
      const html = buildChurnAlertEmail([piiAccount])
      expect(html).not.toContain('cus_pii789')
      expect(html).toContain('cus_***789')
    })
  })
})

describe('no email if the list is empty', () => {
  it('produces valid HTML with 0 rows', () => {
    const html = buildChurnAlertEmail([])
    expect(html).toContain('0 account')
    expect(html).toContain('<tbody></tbody>')
  })
})

describe('buildChurnAlertEmail — null health_score (health_score_status=insufficient)', () => {
  it('renders N/A instead of "null/100"', () => {
    const html = buildChurnAlertEmail([{ ...baseAccount, health_score: null }])
    expect(html).toContain('N/A')
    expect(html).not.toContain('null/100')
  })
})

describe('isEligibleForChurnAlert (S9 triage)', () => {
  const now = new Date('2026-07-25T00:00:00Z').getTime()
  const criticalSignal: TriggeredSignal = { code: 'invoice_overdue_15d', label: 'x', severity: 'CRITIQUE', points: 35 }
  const minorSignal: TriggeredSignal = { code: 'plan_downgrade_6mo', label: 'x', severity: 'MINEUR', points: 10 }

  it('returns false when band is not high', () => {
    expect(isEligibleForChurnAlert({
      churnRiskBand: 'watch', lastChurnAlertAt: null, lastAlertSignalCodes: null, riskSignalsTriggered: [], now,
    })).toBe(false)
  })

  it('returns true on first-ever alert (never alerted before)', () => {
    expect(isEligibleForChurnAlert({
      churnRiskBand: 'high', lastChurnAlertAt: null, lastAlertSignalCodes: null, riskSignalsTriggered: [criticalSignal], now,
    })).toBe(true)
  })

  it('returns false within the 14-day cooldown with no new CRITIQUE signal', () => {
    const lastAlert = new Date(now - 5 * 86400000).toISOString()
    expect(isEligibleForChurnAlert({
      churnRiskBand: 'high', lastChurnAlertAt: lastAlert, lastAlertSignalCodes: ['invoice_overdue_15d'], riskSignalsTriggered: [criticalSignal], now,
    })).toBe(false)
  })

  it('returns true once the 14-day cooldown has elapsed', () => {
    const lastAlert = new Date(now - 15 * 86400000).toISOString()
    expect(isEligibleForChurnAlert({
      churnRiskBand: 'high', lastChurnAlertAt: lastAlert, lastAlertSignalCodes: ['invoice_overdue_15d'], riskSignalsTriggered: [criticalSignal], now,
    })).toBe(true)
  })

  it('bypasses the cooldown when a new CRITIQUE signal appears', () => {
    const lastAlert = new Date(now - 2 * 86400000).toISOString()
    expect(isEligibleForChurnAlert({
      churnRiskBand: 'high', lastChurnAlertAt: lastAlert, lastAlertSignalCodes: ['invoice_overdue_15d'],
      riskSignalsTriggered: [criticalSignal, { code: 'mrr_contraction_20pct_3mo', label: 'x', severity: 'CRITIQUE', points: 30 }], now,
    })).toBe(true)
  })

  it('does not bypass the cooldown for a new MINEUR signal', () => {
    const lastAlert = new Date(now - 2 * 86400000).toISOString()
    expect(isEligibleForChurnAlert({
      churnRiskBand: 'high', lastChurnAlertAt: lastAlert, lastAlertSignalCodes: ['invoice_overdue_15d'],
      riskSignalsTriggered: [criticalSignal, minorSignal], now,
    })).toBe(false)
  })
})
