import { describe, it, expect } from 'vitest'
import { detectMrrCollapseAnomaly, type AccountMrrUpdate } from '../functions/_shared/sync-anomaly-guard'

function prevMap(entries: Array<[string, number]>): Map<string, number> {
  return new Map(entries)
}

describe('detectMrrCollapseAnomaly', () => {
  it('retourne isAnomaly=false quand aucun compte ne passe à 0', () => {
    const prev = prevMap([['a1', 10000], ['a2', 20000]])
    const rows: AccountMrrUpdate[] = [
      { id: 'a1', mrr_cents: 10000 },
      { id: 'a2', mrr_cents: 20000 },
    ]
    const result = detectMrrCollapseAnomaly(prev, rows)
    expect(result).toMatchObject({ affectedCount: 0, isAnomaly: false })
  })

  it('retourne isAnomaly=false si le ratio dépasse le seuil mais affectedCount < 5 (garde-fou petit org)', () => {
    const prev = prevMap([['a1', 1000], ['a2', 1000], ['a3', 1000]])
    const rows: AccountMrrUpdate[] = [
      { id: 'a1', mrr_cents: 0 },
      { id: 'a2', mrr_cents: 0 },
      { id: 'a3', mrr_cents: 1000 },
    ]
    const result = detectMrrCollapseAnomaly(prev, rows)
    expect(result.ratio).toBeCloseTo(0.666, 2)
    expect(result.affectedCount).toBe(2)
    expect(result.isAnomaly).toBe(false)
  })

  it('retourne isAnomaly=false quand le ratio est exactement au seuil (comparaison stricte >)', () => {
    // 3 comptes affectés sur 20 = 15% pile
    const prev = prevMap(Array.from({ length: 20 }, (_, i) => [`a${i}`, 1000] as [string, number]))
    const rows: AccountMrrUpdate[] = Array.from({ length: 20 }, (_, i) => ({
      id: `a${i}`,
      mrr_cents: i < 3 ? 0 : 1000,
    }))
    const result = detectMrrCollapseAnomaly(prev, rows)
    expect(result.ratio).toBeCloseTo(0.15, 5)
    expect(result.isAnomaly).toBe(false)
  })

  it('retourne isAnomaly=true quand le ratio dépasse le seuil avec affectedCount >= 5', () => {
    // 6 comptes affectés sur 20 = 30%
    const prev = prevMap(Array.from({ length: 20 }, (_, i) => [`a${i}`, 1000] as [string, number]))
    const rows: AccountMrrUpdate[] = Array.from({ length: 20 }, (_, i) => ({
      id: `a${i}`,
      mrr_cents: i < 6 ? 0 : 1000,
    }))
    const result = detectMrrCollapseAnomaly(prev, rows)
    expect(result).toMatchObject({ affectedCount: 6, totalCount: 20, isAnomaly: true })
  })

  it('ne compte pas les comptes déjà à 0 avant comme "affectés"', () => {
    const prev = prevMap([['a1', 0], ['a2', 0], ['a3', 0], ['a4', 0], ['a5', 0], ['a6', 1000]])
    const rows: AccountMrrUpdate[] = [
      { id: 'a1', mrr_cents: 0 },
      { id: 'a2', mrr_cents: 0 },
      { id: 'a3', mrr_cents: 0 },
      { id: 'a4', mrr_cents: 0 },
      { id: 'a5', mrr_cents: 0 },
      { id: 'a6', mrr_cents: 0 },
    ]
    const result = detectMrrCollapseAnomaly(prev, rows)
    expect(result.affectedCount).toBe(1) // seul a6 était >0 avant
    expect(result.isAnomaly).toBe(false)
  })

  it('ne signale pas de reprise (mrr 0 → positif) comme une anomalie', () => {
    const prev = prevMap(Array.from({ length: 10 }, (_, i) => [`a${i}`, 0] as [string, number]))
    const rows: AccountMrrUpdate[] = Array.from({ length: 10 }, (_, i) => ({
      id: `a${i}`,
      mrr_cents: 5000,
    }))
    const result = detectMrrCollapseAnomaly(prev, rows)
    expect(result).toMatchObject({ affectedCount: 0, isAnomaly: false })
  })

  it('gère une liste vide sans division par zéro', () => {
    const result = detectMrrCollapseAnomaly(new Map(), [])
    expect(result).toMatchObject({ affectedCount: 0, totalCount: 0, ratio: 0, isAnomaly: false })
  })

  it('traite un compte absent de prevMrrByAccount comme prev=0 (nouveau compte, pas une anomalie)', () => {
    const prev = new Map<string, number>()
    const rows: AccountMrrUpdate[] = [{ id: 'new-account', mrr_cents: 0 }]
    const result = detectMrrCollapseAnomaly(prev, rows)
    expect(result.affectedCount).toBe(0)
  })
})
