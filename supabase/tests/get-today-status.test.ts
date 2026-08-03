import { describe, it, expect } from 'vitest'

// ── Types miroir (get-today-status/index.ts) ──────────────────

interface AccountRow {
  id: string
  display_name: string | null
  mrr_cents: number | null
  churn_risk_score: number | null
}

interface InsightRow {
  title: string
  priority: string
}

type TodayStatus = 'critical' | 'at_risk' | 'stable'

const AT_RISK_CHURN_THRESHOLD = 70
const AT_RISK_RATIO_THRESHOLD = 0.3
const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

// ── Fonctions miroir ────────────────────────────────────────

function determineTodayStatus(
  criticalInsightCount: number,
  atRiskAccountCount: number,
  scoredAccountCount: number,
): TodayStatus {
  if (criticalInsightCount > 0) return 'critical'
  if (scoredAccountCount > 0 && atRiskAccountCount / scoredAccountCount > AT_RISK_RATIO_THRESHOLD) {
    return 'at_risk'
  }
  return 'stable'
}

function selectTopUrgentAccount(accounts: AccountRow[]): AccountRow | null {
  const atRisk = accounts.filter((a) => (a.churn_risk_score ?? 0) > AT_RISK_CHURN_THRESHOLD)
  if (atRisk.length === 0) return null
  return atRisk.reduce((top, a) => ((a.mrr_cents ?? 0) > (top.mrr_cents ?? 0) ? a : top))
}

function selectTopInsightTitle(insights: InsightRow[]): string {
  if (insights.length === 0) return ''
  const sorted = [...insights].sort(
    (a, b) => (PRIORITY_RANK[a.priority] ?? 4) - (PRIORITY_RANK[b.priority] ?? 4),
  )
  return sorted[0].title
}

function countCriticalExcludingChurned(
  insightAccountIds: Array<string | null>,
  churnedAccountIds: Set<string>,
): number {
  return insightAccountIds.filter((id) => id !== null && !churnedAccountIds.has(id)).length
}

// ── Helpers de test ─────────────────────────────────────────

function account(overrides: Partial<AccountRow>): AccountRow {
  return { id: 'a1', display_name: 'Acme', mrr_cents: 10000, churn_risk_score: 0, ...overrides }
}

// ── Tests determineTodayStatus ──────────────────────────────

describe('get-today-status: determineTodayStatus', () => {
  it('retourne critical si au moins 1 insight critique actif', () => {
    expect(determineTodayStatus(1, 0, 100)).toBe('critical')
  })

  it('priorise critical même si le ratio at_risk est aussi dépassé', () => {
    expect(determineTodayStatus(2, 50, 100)).toBe('critical')
  })

  it('retourne at_risk si le ratio de comptes à risque dépasse 30%', () => {
    expect(determineTodayStatus(0, 31, 100)).toBe('at_risk')
  })

  it('retourne stable si le ratio est exactement 30% (seuil strict >)', () => {
    expect(determineTodayStatus(0, 30, 100)).toBe('stable')
  })

  it('retourne stable si aucun compte scoré (évite division par zéro)', () => {
    expect(determineTodayStatus(0, 0, 0)).toBe('stable')
  })

  it('retourne stable si aucun insight critique et ratio faible', () => {
    expect(determineTodayStatus(0, 5, 100)).toBe('stable')
  })
})

// ── Tests selectTopUrgentAccount ─────────────────────────────

describe('get-today-status: selectTopUrgentAccount', () => {
  it('retourne null si aucun compte à risque', () => {
    const accounts = [account({ id: 'a1', churn_risk_score: 50 }), account({ id: 'a2', churn_risk_score: 70 })]
    expect(selectTopUrgentAccount(accounts)).toBeNull()
  })

  it('exclut les comptes avec churn_risk_score exactement 70 (seuil strict >)', () => {
    const accounts = [account({ id: 'a1', churn_risk_score: 70 })]
    expect(selectTopUrgentAccount(accounts)).toBeNull()
  })

  it('retourne le compte à risque avec le MRR le plus élevé', () => {
    const accounts = [
      account({ id: 'a1', churn_risk_score: 75, mrr_cents: 5000 }),
      account({ id: 'a2', churn_risk_score: 80, mrr_cents: 20000 }),
      account({ id: 'a3', churn_risk_score: 90, mrr_cents: 10000 }),
    ]
    expect(selectTopUrgentAccount(accounts)?.id).toBe('a2')
  })

  it('ignore les comptes non à risque même avec un MRR plus élevé', () => {
    const accounts = [
      account({ id: 'a1', churn_risk_score: 40, mrr_cents: 999999 }),
      account({ id: 'a2', churn_risk_score: 71, mrr_cents: 100 }),
    ]
    expect(selectTopUrgentAccount(accounts)?.id).toBe('a2')
  })
})

// ── Tests selectTopInsightTitle ──────────────────────────────

describe('get-today-status: selectTopInsightTitle', () => {
  it('retourne une chaîne vide si aucun insight (jamais null)', () => {
    expect(selectTopInsightTitle([])).toBe('')
  })

  it('priorise critical > high > medium > low', () => {
    const insights: InsightRow[] = [
      { title: 'Low', priority: 'low' },
      { title: 'Critical', priority: 'critical' },
      { title: 'Medium', priority: 'medium' },
    ]
    expect(selectTopInsightTitle(insights)).toBe('Critical')
  })

  it('retourne le seul insight présent', () => {
    expect(selectTopInsightTitle([{ title: 'Solo', priority: 'medium' }])).toBe('Solo')
  })
})

// ── Tests countCriticalExcludingChurned (D1/C2.2) ─────────────

describe('get-today-status: countCriticalExcludingChurned', () => {
  it('compte tous les insights critiques quand aucun compte n\'est churné', () => {
    expect(countCriticalExcludingChurned(['a1', 'a2'], new Set())).toBe(2)
  })

  it('exclut les insights liés à un compte churné', () => {
    expect(countCriticalExcludingChurned(['a1', 'a2'], new Set(['a2']))).toBe(1)
  })

  it('retourne 0 si tous les comptes concernés sont churnés', () => {
    expect(countCriticalExcludingChurned(['a1', 'a2'], new Set(['a1', 'a2']))).toBe(0)
  })

  it('ignore les account_id null sans planter', () => {
    expect(countCriticalExcludingChurned([null, 'a1'], new Set())).toBe(1)
  })

  it('retourne 0 pour une liste vide', () => {
    expect(countCriticalExcludingChurned([], new Set())).toBe(0)
  })
})
