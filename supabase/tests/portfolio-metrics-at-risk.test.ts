import { describe, it, expect } from 'vitest'

// ── Mirror (dashboard-api/index.ts, computeAccountsAtRisk) ─────────────────
// dashboard-api importe 'jsr:@supabase/functions-js/edge-runtime.d.ts' au
// niveau module (Deno-only) — non résolvable par vitest/node, donc la
// fonction pure est mirrorée ici, comme dominant-dimension.test.ts /
// churn-alert.test.ts le font déjà pour ce fichier.
//
// Audit délinquence 2026-08-06, point 6 (golden dataset demandé par Naima) :
// couvre les 5 cas explicitement listés — compte délinquent chiffrable,
// compte délinquent non chiffrable, compte délinquent ET en bande high
// (absence de double comptage), compte sorti de délinquence (signal
// désarmé), compte délinquent sans aucune facture (mrr_status indépendant
// des données facture — cette fonction ne regarde que mrr_status/
// churn_risk_band/is_delinquent, jamais les factures elles-mêmes).

interface AtRiskAccountRow {
  churn_risk_band: string | null
  is_delinquent: boolean
  mrr_status: string | null
  mrr_cents: number | null
}

function computeAccountsAtRisk(accounts: AtRiskAccountRow[]): {
  atRiskCount: number
  mrrAtRiskCents: number
  unpricedCount: number
} {
  const atRisk = accounts.filter((a) => a.churn_risk_band === 'high' || a.is_delinquent)
  const priced = atRisk.filter((a) => a.mrr_status !== 'unavailable')
  const mrrAtRiskCents = priced.reduce((sum, a) => sum + (a.mrr_cents ?? 0), 0)
  return {
    atRiskCount: atRisk.length,
    mrrAtRiskCents,
    unpricedCount: atRisk.length - priced.length,
  }
}

function account(overrides: Partial<AtRiskAccountRow>): AtRiskAccountRow {
  return { churn_risk_band: 'low', is_delinquent: false, mrr_status: 'ok', mrr_cents: 10000, ...overrides }
}

describe('computeAccountsAtRisk', () => {
  it('a billable delinquent account counts toward both atRiskCount and mrrAtRiskCents', () => {
    const result = computeAccountsAtRisk([account({ is_delinquent: true, mrr_status: 'ok', mrr_cents: 50000 })])
    expect(result.atRiskCount).toBe(1)
    expect(result.mrrAtRiskCents).toBe(50000)
    expect(result.unpricedCount).toBe(0)
  })

  it('a non-billable delinquent account (mrr_status=unavailable) counts toward atRiskCount but not mrrAtRiskCents — the trap Naima flagged before implementation', () => {
    const result = computeAccountsAtRisk([account({ is_delinquent: true, mrr_status: 'unavailable', mrr_cents: 0 })])
    expect(result.atRiskCount).toBe(1)
    expect(result.mrrAtRiskCents).toBe(0)
    expect(result.unpricedCount).toBe(1)
  })

  it('a delinquent account also in churn_risk_band=high is counted once, not twice', () => {
    const result = computeAccountsAtRisk([account({ is_delinquent: true, churn_risk_band: 'high', mrr_status: 'ok', mrr_cents: 20000 })])
    expect(result.atRiskCount).toBe(1)
    expect(result.mrrAtRiskCents).toBe(20000)
  })

  it('an account that left delinquency (is_delinquent=false) is excluded, even with a high churn score elsewhere unrelated', () => {
    const result = computeAccountsAtRisk([account({ is_delinquent: false, churn_risk_band: 'watch' })])
    expect(result.atRiskCount).toBe(0)
    expect(result.mrrAtRiskCents).toBe(0)
  })

  it('a delinquent account with zero invoices still counts — this function never reads invoice data, only mrr_status/churn_risk_band/is_delinquent', () => {
    const result = computeAccountsAtRisk([account({ is_delinquent: true, mrr_status: 'ok', mrr_cents: 15000 })])
    expect(result.atRiskCount).toBe(1)
    expect(result.mrrAtRiskCents).toBe(15000)
  })

  it('mixes priced and unpriced at-risk accounts correctly across a portfolio', () => {
    const result = computeAccountsAtRisk([
      account({ is_delinquent: true, mrr_status: 'ok', mrr_cents: 10000 }),
      account({ is_delinquent: true, mrr_status: 'unavailable', mrr_cents: 0 }),
      account({ churn_risk_band: 'high', mrr_status: 'ok', mrr_cents: 5000 }),
      account({ is_delinquent: false, churn_risk_band: 'low' }),
    ])
    expect(result.atRiskCount).toBe(3)
    expect(result.mrrAtRiskCents).toBe(15000)
    expect(result.unpricedCount).toBe(1)
  })

  it('churn_risk_band=watch alone (not high, not delinquent) is not at risk', () => {
    const result = computeAccountsAtRisk([account({ churn_risk_band: 'watch' })])
    expect(result.atRiskCount).toBe(0)
  })

  it('an empty portfolio returns all zeros, not an error', () => {
    const result = computeAccountsAtRisk([])
    expect(result).toEqual({ atRiskCount: 0, mrrAtRiskCents: 0, unpricedCount: 0 })
  })
})
