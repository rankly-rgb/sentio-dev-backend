import { describe, it, expect } from 'vitest'

// ── Types miroir (onboarding-first-win/index.ts) ──────────────

interface AccountRow {
  id: string
  stripe_customer_id: string
  display_name: string | null
  health_score: number | null
  churn_risk_score: number | null
  mrr_cents: number | null
  financial_score: number | null
}

interface InvoiceRow {
  account_id: string
  due_date: string | null
  status: string
}

interface AtRiskAccount {
  stripe_customer_id: string
  display_name: string | null
  health_score: number
  churn_risk: number
  mrr: number
  top_risk_reason: string
}

// ── Traductions miroir (subset utilisé dans buildRiskReason) ─────

type Lang = 'fr' | 'en'

const TRANSLATIONS: Record<Lang, Record<string, string>> = {
  fr: {
    'risk.overdue_invoice': 'Invoice impayée depuis {{days}} jour(s)',
    'risk.no_usage_days': 'Aucune connexion depuis {{days}} jours',
    'risk.no_usage_long': 'Aucune connexion depuis plus de 30 jours',
    'risk.financial_degraded': 'Santé financière dégradée',
    'risk.low_health': 'Score de santé faible',
  },
  en: {
    'risk.overdue_invoice': 'Overdue invoice for {{days}} day(s)',
    'risk.no_usage_days': 'No activity for {{days}} days',
    'risk.no_usage_long': 'No activity for over 30 days',
    'risk.financial_degraded': 'Degraded financial health',
    'risk.low_health': 'Low health score',
  },
}

function t(lang: Lang, key: string, params?: Record<string, string | number>): string {
  let str = TRANSLATIONS[lang]?.[key] ?? TRANSLATIONS['fr'][key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v))
    }
  }
  return str
}

// ── Logique pure miroir ───────────────────────────────────────

function buildRiskReason(
  account: AccountRow,
  overdueByAccount: Map<string, InvoiceRow>,
  lastUsageByAccount: Map<string, string>,
  today: number,
  lang: Lang = 'fr',
): string {
  const overdueInvoice = overdueByAccount.get(account.id)
  if (overdueInvoice?.due_date) {
    const dueDaysAgo = Math.floor((today - new Date(overdueInvoice.due_date).getTime()) / (1000 * 60 * 60 * 24))
    if (dueDaysAgo > 0) {
      return t(lang, 'risk.overdue_invoice', { days: dueDaysAgo })
    }
  }

  const lastUsageAt = lastUsageByAccount.get(account.id)
  if (lastUsageAt) {
    const daysSinceUsage = Math.floor((today - new Date(lastUsageAt).getTime()) / (1000 * 60 * 60 * 24))
    if (daysSinceUsage >= 30) {
      return t(lang, 'risk.no_usage_days', { days: daysSinceUsage })
    }
  } else {
    return t(lang, 'risk.no_usage_long')
  }

  if ((account.financial_score ?? 100) < 30) {
    return t(lang, 'risk.financial_degraded')
  }

  return t(lang, 'risk.low_health')
}

function calcMrrAtRisk(accounts: AccountRow[]): number {
  return accounts
    .filter((a) => (a.health_score ?? 100) < 40)
    .reduce((sum, a) => sum + (a.mrr_cents ?? 0), 0)
}

function calcGlobalHealthScore(accounts: AccountRow[]): number {
  if (accounts.length === 0) return 0
  const total = accounts.reduce((sum, a) => sum + (a.health_score ?? 0), 0)
  return Math.round(total / accounts.length)
}

function buildAtRiskAccounts(
  accounts: AccountRow[],
  overdueByAccount: Map<string, InvoiceRow>,
  lastUsageByAccount: Map<string, string>,
  today: number,
): AtRiskAccount[] {
  const sorted = [...accounts]
    .filter((a) => a.health_score !== null)
    .sort((a, b) => (a.health_score ?? 0) - (b.health_score ?? 0))
  const top3 = sorted.slice(0, 3)
  return top3.map((account) => ({
    stripe_customer_id: account.stripe_customer_id,
    display_name: account.display_name,
    health_score: account.health_score ?? 0,
    churn_risk: account.churn_risk_score ?? 0,
    mrr: account.mrr_cents ?? 0,
    top_risk_reason: buildRiskReason(account, overdueByAccount, lastUsageByAccount, today),
  }))
}

// ── Fixtures ──────────────────────────────────────────────────

const TODAY = new Date('2026-04-30T12:00:00Z').getTime()

function makeAccount(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'acct-001',
    stripe_customer_id: 'cus_TEST001',
    display_name: 'Acme Corp',
    health_score: 30,
    churn_risk_score: 70,
    mrr_cents: 49900,
    financial_score: 50,
    ...overrides,
  }
}

// ── Tests buildRiskReason ────────────────────────────────────

describe('onboarding-first-win: buildRiskReason (FR)', () => {
  it('retourne le message facture impayée en FR', () => {
    const account = makeAccount({ id: 'a1' })
    const overdue = new Map<string, InvoiceRow>([
      ['a1', { account_id: 'a1', due_date: '2026-04-10', status: 'open' }],
    ])
    const reason = buildRiskReason(account, overdue, new Map(), TODAY, 'fr')
    expect(reason).toContain('Invoice impayée depuis')
    expect(reason).toContain('jour')
  })

  it('retourne "Aucune connexion depuis plus de 30 jours" en FR si aucun usage', () => {
    const account = makeAccount({ id: 'a1' })
    expect(buildRiskReason(account, new Map(), new Map(), TODAY, 'fr')).toBe(
      'Aucune connexion depuis plus de 30 jours',
    )
  })

  it('retourne "Santé financière dégradée" en FR', () => {
    const account = makeAccount({ id: 'a1', financial_score: 15 })
    const recent = new Date(TODAY - 5 * 24 * 60 * 60 * 1000).toISOString()
    expect(buildRiskReason(account, new Map(), new Map([['a1', recent]]), TODAY, 'fr')).toBe(
      'Santé financière dégradée',
    )
  })

  it('retourne "Score de santé faible" en FR en dernier recours', () => {
    const account = makeAccount({ id: 'a1', financial_score: 60 })
    const recent = new Date(TODAY - 10 * 24 * 60 * 60 * 1000).toISOString()
    expect(buildRiskReason(account, new Map(), new Map([['a1', recent]]), TODAY, 'fr')).toBe(
      'Score de santé faible',
    )
  })

  it("priorité : facture impayée prime sur absence d'usage (FR)", () => {
    const account = makeAccount({ id: 'a1' })
    const overdue = new Map<string, InvoiceRow>([
      ['a1', { account_id: 'a1', due_date: '2026-04-01', status: 'open' }],
    ])
    expect(buildRiskReason(account, overdue, new Map(), TODAY, 'fr')).toContain('Invoice impayée')
  })
})

describe('onboarding-first-win: buildRiskReason (EN)', () => {
  it('retourne le message facture impayée en EN', () => {
    const account = makeAccount({ id: 'a1' })
    const overdue = new Map<string, InvoiceRow>([
      ['a1', { account_id: 'a1', due_date: '2026-04-10', status: 'open' }],
    ])
    const reason = buildRiskReason(account, overdue, new Map(), TODAY, 'en')
    expect(reason).toContain('Overdue invoice for')
    expect(reason).toContain('day')
  })

  it('retourne "No activity for over 30 days" en EN si aucun usage', () => {
    const account = makeAccount({ id: 'a1' })
    expect(buildRiskReason(account, new Map(), new Map(), TODAY, 'en')).toBe(
      'No activity for over 30 days',
    )
  })

  it('retourne "Degraded financial health" en EN', () => {
    const account = makeAccount({ id: 'a1', financial_score: 15 })
    const recent = new Date(TODAY - 5 * 24 * 60 * 60 * 1000).toISOString()
    expect(buildRiskReason(account, new Map(), new Map([['a1', recent]]), TODAY, 'en')).toBe(
      'Degraded financial health',
    )
  })

  it('retourne "Low health score" en EN en dernier recours', () => {
    const account = makeAccount({ id: 'a1', financial_score: 60 })
    const recent = new Date(TODAY - 10 * 24 * 60 * 60 * 1000).toISOString()
    expect(buildRiskReason(account, new Map(), new Map([['a1', recent]]), TODAY, 'en')).toBe(
      'Low health score',
    )
  })

  it('retourne "No activity for X days" en EN si usage > 30j', () => {
    const account = makeAccount({ id: 'a1' })
    const longAgo = new Date(TODAY - 45 * 24 * 60 * 60 * 1000).toISOString()
    const reason = buildRiskReason(account, new Map(), new Map([['a1', longAgo]]), TODAY, 'en')
    expect(reason).toContain('No activity for')
    expect(reason).toContain('days')
  })
})

// ── Tests sélection top 3 ────────────────────────────────────

describe('onboarding-first-win: sélection top 3 comptes à risque', () => {
  it('retourne les 3 comptes avec health_score le plus bas', () => {
    const accounts = [
      makeAccount({ id: 'a1', stripe_customer_id: 'cus_A', health_score: 65 }),
      makeAccount({ id: 'a2', stripe_customer_id: 'cus_B', health_score: 20 }),
      makeAccount({ id: 'a3', stripe_customer_id: 'cus_C', health_score: 45 }),
      makeAccount({ id: 'a4', stripe_customer_id: 'cus_D', health_score: 10 }),
      makeAccount({ id: 'a5', stripe_customer_id: 'cus_E', health_score: 80 }),
    ]
    const result = buildAtRiskAccounts(accounts, new Map(), new Map(), TODAY)
    expect(result).toHaveLength(3)
    expect(result[0].stripe_customer_id).toBe('cus_D') // 10
    expect(result[1].stripe_customer_id).toBe('cus_B') // 20
    expect(result[2].stripe_customer_id).toBe('cus_C') // 45
  })

  it('retourne moins de 3 comptes si moins de 3 existent', () => {
    const accounts = [
      makeAccount({ id: 'a1', health_score: 30 }),
      makeAccount({ id: 'a2', health_score: 50 }),
    ]
    const result = buildAtRiskAccounts(accounts, new Map(), new Map(), TODAY)
    expect(result).toHaveLength(2)
  })

  it('exclut les comptes sans health_score (null)', () => {
    const accounts = [
      makeAccount({ id: 'a1', health_score: null }),
      makeAccount({ id: 'a2', health_score: 30 }),
      makeAccount({ id: 'a3', health_score: 50 }),
    ]
    const result = buildAtRiskAccounts(accounts, new Map(), new Map(), TODAY)
    expect(result).toHaveLength(2)
    expect(result.some((r) => r.health_score === 0 && r.stripe_customer_id !== accounts[0].stripe_customer_id)).toBe(false)
  })

  it('retourne liste vide si aucun compte scoré', () => {
    const accounts = [makeAccount({ id: 'a1', health_score: null })]
    const result = buildAtRiskAccounts(accounts, new Map(), new Map(), TODAY)
    expect(result).toHaveLength(0)
  })
})

// ── Tests calcMrrAtRisk ───────────────────────────────────────

describe('onboarding-first-win: calcul mrr_at_risk', () => {
  it('additionne le MRR des comptes avec health_score < 40', () => {
    const accounts = [
      makeAccount({ id: 'a1', health_score: 20, mrr_cents: 49900 }),
      makeAccount({ id: 'a2', health_score: 39, mrr_cents: 29900 }),
      makeAccount({ id: 'a3', health_score: 40, mrr_cents: 99900 }), // exactement 40 = exclu
      makeAccount({ id: 'a4', health_score: 80, mrr_cents: 19900 }),
    ]
    expect(calcMrrAtRisk(accounts)).toBe(79800) // 49900 + 29900
  })

  it('retourne 0 si aucun compte à risque', () => {
    const accounts = [
      makeAccount({ id: 'a1', health_score: 60, mrr_cents: 50000 }),
      makeAccount({ id: 'a2', health_score: 80, mrr_cents: 30000 }),
    ]
    expect(calcMrrAtRisk(accounts)).toBe(0)
  })

  it('traite mrr_cents null comme 0', () => {
    const accounts = [
      makeAccount({ id: 'a1', health_score: 10, mrr_cents: null }),
    ]
    expect(calcMrrAtRisk(accounts)).toBe(0)
  })

  it('traite health_score null comme 100 (pas à risque)', () => {
    const accounts = [
      makeAccount({ id: 'a1', health_score: null, mrr_cents: 50000 }),
    ]
    expect(calcMrrAtRisk(accounts)).toBe(0)
  })
})

// ── Tests calcGlobalHealthScore ───────────────────────────────

describe('onboarding-first-win: calcul global_health_score', () => {
  it('calcule la moyenne arrondie des health scores', () => {
    const accounts = [
      makeAccount({ health_score: 30 }),
      makeAccount({ health_score: 50 }),
      makeAccount({ health_score: 70 }),
    ]
    expect(calcGlobalHealthScore(accounts)).toBe(50)
  })

  it("arrondit à l'entier le plus proche", () => {
    const accounts = [
      makeAccount({ health_score: 33 }),
      makeAccount({ health_score: 34 }),
    ]
    // (33 + 34) / 2 = 33.5 → arrondi à 34
    expect(calcGlobalHealthScore(accounts)).toBe(34)
  })

  it('retourne 0 pour une liste vide', () => {
    expect(calcGlobalHealthScore([])).toBe(0)
  })

  it('traite health_score null comme 0 dans la moyenne', () => {
    const accounts = [
      makeAccount({ health_score: 60 }),
      makeAccount({ health_score: null }),
    ]
    expect(calcGlobalHealthScore(accounts)).toBe(30) // (60 + 0) / 2
  })
})

// ── Tests Zero-PII ────────────────────────────────────────────

describe('onboarding-first-win: Zero-PII', () => {
  it("les at_risk_accounts ne contiennent pas de clé 'email'", () => {
    const accounts = [makeAccount({ id: 'a1', health_score: 20 })]
    const result = buildAtRiskAccounts(accounts, new Map(), new Map(), TODAY)
    const json = JSON.stringify(result)
    expect(json).not.toContain('"email"')
  })

  it("les at_risk_accounts ne contiennent pas de clé 'phone'", () => {
    const accounts = [makeAccount({ id: 'a1', health_score: 20 })]
    const result = buildAtRiskAccounts(accounts, new Map(), new Map(), TODAY)
    const json = JSON.stringify(result)
    expect(json).not.toContain('"phone"')
  })

  it("les at_risk_accounts ne contiennent pas de clé 'ip'", () => {
    const accounts = [makeAccount({ id: 'a1', health_score: 20 })]
    const result = buildAtRiskAccounts(accounts, new Map(), new Map(), TODAY)
    const keys = collectKeys(result)
    expect(keys).not.toContain('ip')
  })

  it("les at_risk_accounts ne contiennent pas de clé 'name'", () => {
    const accounts = [makeAccount({ id: 'a1', health_score: 20 })]
    const result = buildAtRiskAccounts(accounts, new Map(), new Map(), TODAY)
    const keys = collectKeys(result)
    expect(keys).not.toContain('name')
  })

  it('stripe_customer_id est présent (identifiant anonyme autorisé)', () => {
    const accounts = [makeAccount({ id: 'a1', health_score: 20, stripe_customer_id: 'cus_ANON' })]
    const result = buildAtRiskAccounts(accounts, new Map(), new Map(), TODAY)
    expect(result[0].stripe_customer_id).toBe('cus_ANON')
  })
})

// ── Helper récursif pour collecter les clés ───────────────────

function collectKeys(obj: unknown): string[] {
  if (typeof obj !== 'object' || obj === null) return []
  if (Array.isArray(obj)) return obj.flatMap(collectKeys)
  const keys: string[] = []
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    keys.push(key)
    keys.push(...collectKeys((obj as Record<string, unknown>)[key]))
  }
  return keys
}
