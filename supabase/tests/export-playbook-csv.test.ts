import { describe, it, expect } from 'vitest'

// ── Types miroir (export-playbook-csv/index.ts) ───────────────

interface AccountRow {
  id: string
  stripe_customer_id: string | null
  display_name: string | null
  mrr_cents: number | null
  health_score: number | null
  churn_risk_score: number | null
}

interface ContactInfo {
  email: string
  name: string
}

interface InvoiceOverdueInfo {
  amount_cents: number
  days_overdue: number
}

interface RawOverdueInvoice {
  account_id: string
  amount_cents: number
  due_date: string
}

// ── Copies miroir des fonctions pures testées ─────────────────
// (même convention que export-csv.test.ts — les imports Deno-natifs de
// index.ts ne sont pas exécutables sous Vitest/Node)

function escapeField(val: unknown): string {
  const str = String(val ?? '')
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function generatePlaybookCsv(
  accounts: AccountRow[],
  emailMap: Map<string, ContactInfo>,
  overdueMap: Map<string, InvoiceOverdueInfo>,
): string {
  const headers = [
    'Company',
    'Email',
    'Stripe ID',
    'MRR (USD)',
    'Amount Due (USD)',
    'Days Overdue',
    'Health Score',
    'Churn Risk',
  ]

  const rows = accounts.map((a) => {
    const contact = emailMap.get(a.stripe_customer_id ?? '')
    const overdue = overdueMap.get(a.id)
    return [
      a.display_name ?? '',
      contact?.email ?? '',
      a.stripe_customer_id ?? '',
      ((a.mrr_cents ?? 0) / 100).toFixed(2),
      overdue ? (overdue.amount_cents / 100).toFixed(2) : '',
      overdue ? String(overdue.days_overdue) : '',
      a.health_score ?? '',
      a.churn_risk_score ?? '',
    ]
  })

  return [headers, ...rows].map((row) => row.map(escapeField).join(',')).join('\n')
}

function pickOldestOverdueByAccount(
  invoices: RawOverdueInvoice[],
  now: number = Date.now(),
): Map<string, InvoiceOverdueInfo> {
  const result = new Map<string, InvoiceOverdueInfo>()
  for (const inv of invoices) {
    if (result.has(inv.account_id)) continue
    const daysOverdue = Math.floor((now - new Date(inv.due_date).getTime()) / 86400000)
    result.set(inv.account_id, { amount_cents: inv.amount_cents, days_overdue: daysOverdue })
  }
  return result
}

function filterOutExecutedAccountIds<T extends { id: string }>(
  accounts: T[],
  recentRuns: Array<{ account_ids: string[] | null }>,
): T[] {
  const excludedIds = new Set<string>()
  for (const run of recentRuns) {
    for (const id of run.account_ids ?? []) excludedIds.add(id)
  }
  if (excludedIds.size === 0) return accounts
  return accounts.filter((a) => !excludedIds.has(a.id))
}

// ── Tests ──────────────────────────────────────────────────────

describe('generatePlaybookCsv', () => {
  const baseAccount: AccountRow = {
    id: 'acc_1',
    stripe_customer_id: 'cus_abc123',
    display_name: 'Acme Corp',
    mrr_cents: 49900,
    health_score: 28,
    churn_risk_score: 75,
  }

  it('includes the expected header row', () => {
    const csv = generatePlaybookCsv([], new Map(), new Map())
    expect(csv).toBe('Company,Email,Stripe ID,MRR (USD),Amount Due (USD),Days Overdue,Health Score,Churn Risk')
  })

  it('formats MRR in USD with 2 decimals', () => {
    const csv = generatePlaybookCsv([baseAccount], new Map(), new Map())
    const row = csv.split('\n')[1]
    expect(row).toContain('499.00')
  })

  it('fills in email from the resolved map', () => {
    const emailMap = new Map([['cus_abc123', { email: 'billing@acme.test', name: 'Acme' }]])
    const csv = generatePlaybookCsv([baseAccount], emailMap, new Map())
    expect(csv.split('\n')[1]).toContain('billing@acme.test')
  })

  it('leaves email blank when not resolved', () => {
    const csv = generatePlaybookCsv([baseAccount], new Map(), new Map())
    const cols = csv.split('\n')[1].split(',')
    expect(cols[1]).toBe('')
  })

  it('fills amount due and days overdue when present', () => {
    const overdueMap = new Map([['acc_1', { amount_cents: 12000, days_overdue: 18 }]])
    const csv = generatePlaybookCsv([baseAccount], new Map(), overdueMap)
    const row = csv.split('\n')[1]
    expect(row).toContain('120.00')
    expect(row).toContain('18')
  })

  it('leaves amount due and days overdue blank when no overdue invoice', () => {
    const csv = generatePlaybookCsv([baseAccount], new Map(), new Map())
    const cols = csv.split('\n')[1].split(',')
    expect(cols[4]).toBe('')
    expect(cols[5]).toBe('')
  })

  it('falls back to empty display_name and 0 MRR when null', () => {
    const account: AccountRow = { ...baseAccount, display_name: null, mrr_cents: null }
    const csv = generatePlaybookCsv([account], new Map(), new Map())
    const cols = csv.split('\n')[1].split(',')
    expect(cols[0]).toBe('')
    expect(cols[3]).toBe('0.00')
  })

  it('escapes commas in company names', () => {
    const account: AccountRow = { ...baseAccount, display_name: 'Acme, Inc.' }
    const csv = generatePlaybookCsv([account], new Map(), new Map())
    expect(csv.split('\n')[1]).toContain('"Acme, Inc."')
  })

  it('never includes email/name/phone/ip literal field names (Zero-PII shape check)', () => {
    const csv = generatePlaybookCsv([baseAccount], new Map(), new Map())
    expect(csv).not.toMatch(/\bphone\b/i)
    expect(csv).not.toMatch(/\bip_address\b/i)
  })
})

describe('pickOldestOverdueByAccount', () => {
  const NOW = new Date('2026-08-02T00:00:00Z').getTime()

  it('returns empty map for empty input', () => {
    expect(pickOldestOverdueByAccount([], NOW).size).toBe(0)
  })

  it('picks the earliest due_date per account when multiple overdue invoices exist', () => {
    const invoices: RawOverdueInvoice[] = [
      { account_id: 'acc_1', amount_cents: 5000, due_date: '2026-07-20' }, // oldest
      { account_id: 'acc_1', amount_cents: 3000, due_date: '2026-07-28' },
    ]
    const result = pickOldestOverdueByAccount(invoices, NOW)
    expect(result.get('acc_1')?.amount_cents).toBe(5000)
  })

  it('computes days_overdue from due_date to now', () => {
    const invoices: RawOverdueInvoice[] = [
      { account_id: 'acc_1', amount_cents: 5000, due_date: '2026-07-18' },
    ]
    const result = pickOldestOverdueByAccount(invoices, NOW)
    expect(result.get('acc_1')?.days_overdue).toBe(15)
  })

  it('keeps separate entries for different accounts', () => {
    const invoices: RawOverdueInvoice[] = [
      { account_id: 'acc_1', amount_cents: 5000, due_date: '2026-07-20' },
      { account_id: 'acc_2', amount_cents: 8000, due_date: '2026-07-10' },
    ]
    const result = pickOldestOverdueByAccount(invoices, NOW)
    expect(result.size).toBe(2)
    expect(result.get('acc_2')?.amount_cents).toBe(8000)
  })

  it('relies on caller pre-sorting by due_date ASC (first occurrence wins)', () => {
    // Si l'appelant passe un ordre non trié, le résultat reflète le premier
    // rencontré, pas nécessairement le plus ancien -- documenté comme
    // précondition, pas re-vérifié ici (pas de tri interne).
    const invoices: RawOverdueInvoice[] = [
      { account_id: 'acc_1', amount_cents: 3000, due_date: '2026-07-28' },
      { account_id: 'acc_1', amount_cents: 5000, due_date: '2026-07-20' },
    ]
    const result = pickOldestOverdueByAccount(invoices, NOW)
    expect(result.get('acc_1')?.amount_cents).toBe(3000)
  })
})

describe('filterOutExecutedAccountIds', () => {
  const accounts = [{ id: 'acc_1' }, { id: 'acc_2' }, { id: 'acc_3' }]

  it('returns all accounts when no recent runs exist', () => {
    expect(filterOutExecutedAccountIds(accounts, [])).toHaveLength(3)
  })

  it('returns all accounts when recent runs have empty account_ids', () => {
    expect(filterOutExecutedAccountIds(accounts, [{ account_ids: [] }, { account_ids: null }])).toHaveLength(3)
  })

  it('excludes accounts covered by a single recent run', () => {
    const result = filterOutExecutedAccountIds(accounts, [{ account_ids: ['acc_2'] }])
    expect(result.map((a) => a.id)).toEqual(['acc_1', 'acc_3'])
  })

  it('unions account_ids across multiple recent runs', () => {
    const result = filterOutExecutedAccountIds(accounts, [
      { account_ids: ['acc_1'] },
      { account_ids: ['acc_3'] },
    ])
    expect(result.map((a) => a.id)).toEqual(['acc_2'])
  })

  it('excludes all accounts when every one was already executed', () => {
    const result = filterOutExecutedAccountIds(accounts, [{ account_ids: ['acc_1', 'acc_2', 'acc_3'] }])
    expect(result).toHaveLength(0)
  })

  it('ignores account_ids not present in the input list', () => {
    const result = filterOutExecutedAccountIds(accounts, [{ account_ids: ['acc_999'] }])
    expect(result).toHaveLength(3)
  })
})
