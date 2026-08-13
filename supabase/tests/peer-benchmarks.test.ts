import { describe, it, expect } from 'vitest'

// ── Types miroir (compute-peer-benchmarks/index.ts) ──────────

type OrgMetrics = { nrr: number; churnRate: number; mrrGrowth: number }

// ── Logique pure miroir ───────────────────────────────────────

function calcOrgMetrics(
  currentMrr: number,
  movements: Array<{ movement_type: string; amount_cents: number | null }>,
): OrgMetrics | null {
  let new12m = 0, expansion12m = 0, contraction12m = 0, churn12m = 0, reactivation12m = 0
  for (const m of movements) {
    const amt = m.amount_cents ?? 0
    switch (m.movement_type) {
      case 'new': new12m += amt; break
      case 'expansion': expansion12m += amt; break
      case 'contraction': contraction12m += amt; break
      case 'churn': churn12m += amt; break
      case 'reactivation': reactivation12m += amt; break
    }
  }
  // contraction/churn sont stockés NÉGATIFS (mirror de compute-peer-benchmarks/index.ts) —
  // additionnés, pas soustraits. Issue #28.
  const netMovements = new12m + expansion12m + reactivation12m + contraction12m + churn12m
  const startingMrr = currentMrr - netMovements
  if (startingMrr <= 0) return null
  const endingMrrExisting = currentMrr - new12m
  const nrr = Math.round((endingMrrExisting / startingMrr) * 1000) / 10
  const churnRate = Math.round((Math.abs(churn12m) / startingMrr) * 1000) / 10
  const mrrGrowth = Math.round((netMovements / startingMrr) * 1000) / 10
  return { nrr, churnRate, mrrGrowth }
}

function computePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (p / 100) * (sorted.length - 1)
  const lower = Math.floor(idx)
  const upper = Math.ceil(idx)
  if (lower === upper) return Math.round(sorted[lower] * 100) / 100
  const interpolated = sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower)
  return Math.round(interpolated * 100) / 100
}

function buildPeerSnapshot(metrics: OrgMetrics[]) {
  const nrrs = metrics.map(m => m.nrr).sort((a, b) => a - b)
  const churns = metrics.map(m => m.churnRate).sort((a, b) => a - b)
  const growths = metrics.map(m => m.mrrGrowth).sort((a, b) => a - b)
  return {
    org_count: metrics.length,
    nrr_p25: computePercentile(nrrs, 25),
    nrr_p50: computePercentile(nrrs, 50),
    nrr_p75: computePercentile(nrrs, 75),
    churn_rate_p25: computePercentile(churns, 25),
    churn_rate_p50: computePercentile(churns, 50),
    churn_rate_p75: computePercentile(churns, 75),
    mrr_growth_p25: computePercentile(growths, 25),
    mrr_growth_p50: computePercentile(growths, 50),
    mrr_growth_p75: computePercentile(growths, 75),
  }
}

// ── calcOrgMetrics ────────────────────────────────────────────

describe('calcOrgMetrics', () => {
  it('retourne null si startingMrr <= 0 (org sans historique)', () => {
    // currentMrr = 10000, new = 12000 → startingMrr = -2000
    const result = calcOrgMetrics(10000, [
      { movement_type: 'new', amount_cents: 12000 },
    ])
    expect(result).toBeNull()
  })

  it('calcule correctement NRR, churnRate, mrrGrowth (churn stocké NÉGATIF — vraie convention DB, cf. classifyMovement/mrr-engine.ts)', () => {
    // startingMrr = 100000, expansion = 20000, churn = -5000 (négatif : convention réelle)
    const currentMrr = 115000
    const movements = [
      { movement_type: 'expansion', amount_cents: 20000 },
      { movement_type: 'churn', amount_cents: -5000 },
    ]
    // net = 20000 + (-5000) = 15000 ; startingMrr = 115000 - 15000 = 100000
    // NRR = (115000 - 0) / 100000 * 100 = 115.0
    // churnRate = |−5000| / 100000 * 100 = 5.0
    // mrrGrowth = 15000 / 100000 * 100 = 15.0
    const result = calcOrgMetrics(currentMrr, movements)
    expect(result).not.toBeNull()
    expect(result!.nrr).toBe(115.0)
    expect(result!.churnRate).toBe(5.0)
    expect(result!.mrrGrowth).toBe(15.0)
  })

  it('issue #28 — avec un churn négatif réaliste, une formule qui SOUSTRAIT churn/contraction au lieu de les ADDITIONNER produit un netMovements gonflé (25000 au lieu de 15000) et un churnRate négatif (-5.0 au lieu de 5.0)', () => {
    // Reproduction du bug historique : reprend la formule buggy exacte
    // (- contraction - churn, churnRate sans Math.abs) pour prouver qu'elle
    // diverge de calcOrgMetrics (corrigé) sur des données réalistes — le
    // test miroir d'origine ne l'attrapait pas car son fixture utilisait
    // +5000 (positif), une valeur qui n'existe jamais en pratique.
    function buggyCalcOrgMetrics(currentMrr: number, movements: Array<{ movement_type: string; amount_cents: number | null }>) {
      let new12m = 0, expansion12m = 0, contraction12m = 0, churn12m = 0, reactivation12m = 0
      for (const m of movements) {
        const amt = m.amount_cents ?? 0
        switch (m.movement_type) {
          case 'new': new12m += amt; break
          case 'expansion': expansion12m += amt; break
          case 'contraction': contraction12m += amt; break
          case 'churn': churn12m += amt; break
          case 'reactivation': reactivation12m += amt; break
        }
      }
      const netMovements = new12m + expansion12m + reactivation12m - contraction12m - churn12m
      const startingMrr = currentMrr - netMovements
      if (startingMrr <= 0) return null
      const churnRate = Math.round((churn12m / startingMrr) * 1000) / 10
      return { netMovements, churnRate }
    }

    const movements = [
      { movement_type: 'expansion', amount_cents: 20000 },
      { movement_type: 'churn', amount_cents: -5000 },
    ]
    const buggy = buggyCalcOrgMetrics(115000, movements)!
    expect(buggy.netMovements).toBe(25000) // faux — devrait être 15000
    expect(buggy.churnRate).toBeLessThan(0) // faux — un taux de churn ne peut pas être négatif

    const fixed = calcOrgMetrics(115000, movements)!
    expect(fixed.mrrGrowth).toBe(15.0) // correct
    expect(fixed.churnRate).toBe(5.0) // correct
  })

  it('exclut le new business du calcul NRR', () => {
    // startingMrr = 50000, new = 10000, expansion = 5000
    const currentMrr = 65000
    const movements = [
      { movement_type: 'new', amount_cents: 10000 },
      { movement_type: 'expansion', amount_cents: 5000 },
    ]
    // net = 15000 ; startingMrr = 65000 - 15000 = 50000
    // endingMrrExisting = 65000 - 10000 = 55000
    // NRR = 55000 / 50000 * 100 = 110.0
    const result = calcOrgMetrics(currentMrr, movements)
    expect(result!.nrr).toBe(110.0)
  })

  it('gère les amount_cents null comme 0', () => {
    const result = calcOrgMetrics(100000, [
      { movement_type: 'expansion', amount_cents: null },
    ])
    // net = 0 ; startingMrr = 100000
    expect(result).not.toBeNull()
    expect(result!.nrr).toBe(100.0)
  })

  it('retourne null si startingMrr = 0 exactement', () => {
    const result = calcOrgMetrics(10000, [
      { movement_type: 'new', amount_cents: 10000 },
    ])
    expect(result).toBeNull()
  })
})

// ── computePercentile ─────────────────────────────────────────

describe('computePercentile', () => {
  it('retourne 0 pour liste vide', () => {
    expect(computePercentile([], 50)).toBe(0)
  })

  it('retourne la valeur unique pour liste à 1 élément', () => {
    expect(computePercentile([42], 50)).toBe(42)
  })

  it('calcule la médiane correctement (liste paire)', () => {
    // [10, 20, 30, 40] → p50 = 25
    expect(computePercentile([10, 20, 30, 40], 50)).toBe(25)
  })

  it('calcule p25 et p75 correctement', () => {
    const sorted = [10, 20, 30, 40, 50, 60, 80, 100]
    const p25 = computePercentile(sorted, 25)
    const p75 = computePercentile(sorted, 75)
    expect(p25).toBeLessThan(p75)
    expect(p25).toBeGreaterThanOrEqual(10)
    expect(p75).toBeLessThanOrEqual(100)
  })

  it('retourne min pour p0 et max pour p100', () => {
    const sorted = [5, 15, 25, 35]
    expect(computePercentile(sorted, 0)).toBe(5)
    expect(computePercentile(sorted, 100)).toBe(35)
  })
})

// ── buildPeerSnapshot ─────────────────────────────────────────

describe('buildPeerSnapshot', () => {
  const threeOrgs: OrgMetrics[] = [
    { nrr: 90, churnRate: 10, mrrGrowth: 5 },
    { nrr: 110, churnRate: 5, mrrGrowth: 20 },
    { nrr: 130, churnRate: 2, mrrGrowth: 45 },
  ]

  it('retourne org_count correct', () => {
    expect(buildPeerSnapshot(threeOrgs).org_count).toBe(3)
  })

  it('p50 NRR = médiane des NRR', () => {
    const snap = buildPeerSnapshot(threeOrgs)
    expect(snap.nrr_p50).toBe(110)
  })

  it('p50 churn_rate = médiane des churn rates', () => {
    const snap = buildPeerSnapshot(threeOrgs)
    expect(snap.churn_rate_p50).toBe(5)
  })

  it('p50 mrr_growth = médiane des mrr_growth', () => {
    const snap = buildPeerSnapshot(threeOrgs)
    expect(snap.mrr_growth_p50).toBe(20)
  })

  it('p25 < p50 < p75 pour chaque métrique', () => {
    const snap = buildPeerSnapshot(threeOrgs)
    expect(snap.nrr_p25).toBeLessThan(snap.nrr_p50)
    expect(snap.nrr_p50).toBeLessThan(snap.nrr_p75)
    expect(snap.churn_rate_p25).toBeLessThan(snap.churn_rate_p50)
    expect(snap.mrr_growth_p25).toBeLessThan(snap.mrr_growth_p50)
  })

  it('fonctionne avec un nombre minimal de 3 orgs', () => {
    const snap = buildPeerSnapshot(threeOrgs)
    expect(snap.org_count).toBeGreaterThanOrEqual(3)
  })

  it('fonctionne avec de nombreuses orgs (percentiles stables)', () => {
    const manyOrgs: OrgMetrics[] = Array.from({ length: 100 }, (_, i) => ({
      nrr: 80 + i,
      churnRate: 20 - i * 0.1,
      mrrGrowth: i * 0.5,
    }))
    const snap = buildPeerSnapshot(manyOrgs)
    expect(snap.org_count).toBe(100)
    expect(snap.nrr_p25).toBeLessThan(snap.nrr_p50)
    expect(snap.nrr_p50).toBeLessThan(snap.nrr_p75)
  })
})
