import { describe, it, expect } from 'vitest'
import {
  convertMrrCentsToUsd,
  buildSegmentCsv,
  SEGMENT_CSV_COLUMNS,
  type SegmentAccountRow,
} from '../functions/_shared/segment-export-helpers'

// Étape 5 (chantier de remédiation, 2026-08-23) : première couverture de ce
// fichier — écrite en même temps que le retrait de SEGMENT_FILTERS (V1
// réimplémentée localement, divergée de la décision C2.5 et du moteur V3) et
// le renommage mrr_eur→mrr_usd.

function makeRow(overrides: Partial<SegmentAccountRow> = {}): SegmentAccountRow {
  return {
    stripe_customer_id: 'cus_1',
    hubspot_company_id: null,
    plan_tier: 'growth',
    billing_interval: 'monthly',
    mrr_cents: 12345,
    seat_count: 5,
    seat_limit: 10,
    contract_end_date: null,
    health_score: 80,
    churn_risk_score: 20,
    expansion_score: 40,
    product_usage_score: null,
    ...overrides,
  }
}

describe('convertMrrCentsToUsd', () => {
  it('convertit les cents en dollars avec 2 décimales', () => {
    expect(convertMrrCentsToUsd(12345)).toBe('123.45')
  })
  it('null → chaîne vide (S1 : pas de 0 fabriqué)', () => {
    expect(convertMrrCentsToUsd(null)).toBe('')
  })
  it('0 cents → "0.00" (une vraie valeur zéro, pas une absence)', () => {
    expect(convertMrrCentsToUsd(0)).toBe('0.00')
  })
})

describe('SEGMENT_CSV_COLUMNS — mrr_usd (pas mrr_eur)', () => {
  it('contient mrr_usd', () => {
    expect(SEGMENT_CSV_COLUMNS).toContain('mrr_usd')
    expect(SEGMENT_CSV_COLUMNS).not.toContain('mrr_eur')
  })
})

describe('buildSegmentCsv', () => {
  it('inclut le BOM UTF-8 (compatibilité Excel)', () => {
    const csv = buildSegmentCsv([makeRow()])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
  })

  it('en-tête suit SEGMENT_CSV_COLUMNS', () => {
    const csv = buildSegmentCsv([])
    const header = csv.slice(1).split('\n')[0]
    expect(header).toBe(SEGMENT_CSV_COLUMNS.join(','))
  })

  it('mrr_cents converti en mrr_usd dans la ligne', () => {
    const csv = buildSegmentCsv([makeRow({ mrr_cents: 299900 })])
    const rows = csv.slice(1).split('\n')
    expect(rows[1]).toContain('2999.00')
  })

  it('champs null rendus en chaîne vide', () => {
    const csv = buildSegmentCsv([makeRow({ hubspot_company_id: null, contract_end_date: null })])
    const cols = csv.slice(1).split('\n')[1].split(',')
    const hubspotIdx = SEGMENT_CSV_COLUMNS.indexOf('hubspot_company_id')
    expect(cols[hubspotIdx]).toBe('')
  })

  it('champ contenant une virgule est correctement échappé', () => {
    const csv = buildSegmentCsv([makeRow({ plan_tier: 'growth, annual' })])
    expect(csv).toContain('"growth, annual"')
  })

  it('liste vide produit uniquement le BOM + en-tête', () => {
    const csv = buildSegmentCsv([])
    expect(csv).toBe('﻿' + SEGMENT_CSV_COLUMNS.join(',') + '\n')
  })
})
