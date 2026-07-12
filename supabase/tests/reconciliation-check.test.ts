import { describe, it, expect } from 'vitest'
import { findDrift, type SegmentCount } from '../functions/_shared/reconciliation'

function seg(overrides: Partial<SegmentCount>): SegmentCount {
  return { segment_type: 'champions', cached: 10, live: 10, ...overrides }
}

describe('reconciliation-check: findDrift', () => {
  it('retourne un tableau vide si aucun écart', () => {
    expect(findDrift([seg({ cached: 10, live: 10 })])).toEqual([])
  })

  it('retourne un tableau vide pour une liste vide', () => {
    expect(findDrift([])).toEqual([])
  })

  it('détecte un écart mineur en warning (diff <= 5, <= 10%)', () => {
    const drifts = findDrift([seg({ segment_type: 'stables', cached: 100, live: 102 })])
    expect(drifts).toHaveLength(1)
    expect(drifts[0]).toMatchObject({ segment_type: 'stables', cached: 100, live: 102, diff: 2, severity: 'warning' })
  })

  it('détecte un écart critique en absolu (diff > 5)', () => {
    const drifts = findDrift([seg({ cached: 100, live: 108 })])
    expect(drifts[0].severity).toBe('critical')
  })

  it('détecte un écart critique en pourcentage (> 10% même si diff absolu faible)', () => {
    const drifts = findDrift([seg({ cached: 20, live: 23 })]) // diff=3 (<=5) mais 15% (>10%)
    expect(drifts[0].severity).toBe('critical')
  })

  it('ne signale pas de faux positif quand cached=0 et live=0', () => {
    expect(findDrift([seg({ cached: 0, live: 0 })])).toEqual([])
  })

  it('traite cached=0 avec live>0 comme un écart critique', () => {
    const drifts = findDrift([seg({ cached: 0, live: 3 })])
    expect(drifts).toHaveLength(1)
    expect(drifts[0].severity).toBe('critical')
  })

  it('traite un diff négatif (live < cached) correctement', () => {
    const drifts = findDrift([seg({ cached: 50, live: 40 })])
    expect(drifts[0]).toMatchObject({ diff: -10, severity: 'critical' })
  })

  it('gère plusieurs segments dans la même org, ne retourne que ceux en écart', () => {
    const drifts = findDrift([
      seg({ segment_type: 'champions', cached: 10, live: 10 }),
      seg({ segment_type: 'stables', cached: 50, live: 55 }),
      seg({ segment_type: 'en_churn', cached: 5, live: 5 }),
    ])
    expect(drifts).toHaveLength(1)
    expect(drifts[0].segment_type).toBe('stables')
  })
})
