import { describe, it, expect } from 'vitest'
import {
  computePriority,
  computeDaysToRenewal,
  buildTriggerReason,
  buildHubspotImportNote,
  sortAccounts,
  formatActionType,
  buildCsv,
  type AccountRow,
} from '../functions/_shared/export-helpers'

// Étape 5 (chantier de remédiation, 2026-08-23) : ce fichier n'avait jamais eu
// de couverture de test (rapatriement Lot 8, "à l'identique, aucune
// amélioration") — première couverture, écrite en même temps que la
// correction de la dette devise/langue (mrr_euros→mrr_usd, contenu en
// français dans buildTriggerReason/buildHubspotImportNote/formatActionType,
// jamais English-only malgré la décision produit).

describe('computePriority', () => {
  it('P0: churn critique et renouvellement proche', () => {
    expect(computePriority(75, 20)).toBe('P0')
  })
  it('P1: churn moyen', () => {
    expect(computePriority(55, null)).toBe('P1')
  })
  it('P2: défaut', () => {
    expect(computePriority(10, null)).toBe('P2')
  })
})

describe('computeDaysToRenewal', () => {
  it('null si mensuel (pas de notion de renouvellement)', () => {
    expect(computeDaysToRenewal('2026-09-01', 'monthly')).toBeNull()
  })
  it('null si pas de date de fin', () => {
    expect(computeDaysToRenewal(null, 'annual')).toBeNull()
  })
})

describe('buildTriggerReason — sortie en anglais (English-only, en-US)', () => {
  it('facture impayée', () => {
    const reason = buildTriggerReason({
      hasUnpaidInvoice: true,
      unpaidDays: 20,
      loginDecline: false,
      lastLoginDaysAgo: null,
      daysToRenewal: null,
      churnRisk: null,
      healthScore: null,
    })
    expect(reason).toBe('Unpaid invoice for 20d')
  })

  it('aucun signal actif', () => {
    const reason = buildTriggerReason({
      hasUnpaidInvoice: false,
      unpaidDays: null,
      loginDecline: false,
      lastLoginDaysAgo: null,
      daysToRenewal: null,
      churnRisk: null,
      healthScore: null,
    })
    expect(reason).toBe('No active signal')
  })

  it('plusieurs signaux combinés', () => {
    const reason = buildTriggerReason({
      hasUnpaidInvoice: false,
      unpaidDays: null,
      loginDecline: false,
      lastLoginDaysAgo: null,
      daysToRenewal: 10,
      churnRisk: 80,
      healthScore: 30,
    })
    expect(reason).toBe('Renews in 10d · Critical churn risk (80/100) · Low health score (30/100)')
  })
})

describe('buildHubspotImportNote — sortie en anglais', () => {
  it('P0', () => {
    expect(buildHubspotImportNote(20, 90, 'P0', 'Slack notification')).toBe(
      "This account has a critical churn risk. Health score: 20/100. Priority action: slack notification.",
    )
  })
  it('P1', () => {
    expect(buildHubspotImportNote(50, 55, 'P1', 'Create task')).toBe(
      'This account needs prompt attention. Health score: 50/100. Recommended action: create task.',
    )
  })
  it('P2', () => {
    expect(buildHubspotImportNote(90, 10, 'P2', 'n/a')).toBe(
      'Account under watch. Health score: 90/100. No urgent action required.',
    )
  })
})

describe('formatActionType — labels en anglais', () => {
  it('type connu, sans titre de config', () => {
    expect(formatActionType('slack_notify')).toBe('Slack notification')
  })
  it('type connu, avec titre de config', () => {
    expect(formatActionType('create_task', { title: 'Follow up' })).toBe('Create task : Follow up')
  })
  it('type inconnu : fallback sur le type brut', () => {
    expect(formatActionType('hubspot_enroll_sequence')).toBe('hubspot_enroll_sequence')
  })
})

function makeRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    stripe_customer_id: 'cus_1',
    hubspot_company_id: null,
    plan_tier: null,
    mrr_usd: 100,
    health_score: null,
    churn_risk_score: null,
    expansion_score: null,
    segment: null,
    days_to_renewal: null,
    billing_interval: null,
    trigger_reason: '',
    suggested_playbook: '',
    suggested_action: '',
    priority: 'P2',
    last_login_days_ago: null,
    open_ticket_count: null,
    nps_score: null,
    hubspot_import_note: '',
    ...overrides,
  }
}

describe('sortAccounts — trie par priorité puis mrr_usd (renommé depuis mrr_euros)', () => {
  it('P0 avant P1 avant P2', () => {
    const rows = [makeRow({ priority: 'P2' }), makeRow({ priority: 'P0' }), makeRow({ priority: 'P1' })]
    expect(sortAccounts(rows).map((r) => r.priority)).toEqual(['P0', 'P1', 'P2'])
  })

  it('à priorité égale, mrr_usd décroissant', () => {
    const rows = [
      makeRow({ priority: 'P0', mrr_usd: 50 }),
      makeRow({ priority: 'P0', mrr_usd: 200 }),
      makeRow({ priority: 'P0', mrr_usd: 100 }),
    ]
    expect(sortAccounts(rows).map((r) => r.mrr_usd)).toEqual([200, 100, 50])
  })
})

describe('buildCsv — colonne mrr_usd (pas mrr_euros)', () => {
  it('en-tête contient mrr_usd', () => {
    const csv = buildCsv([makeRow({ mrr_usd: 299 })])
    const [header, row] = csv.split('\n')
    expect(header).toContain('mrr_usd')
    expect(header).not.toContain('mrr_euros')
    expect(row).toContain('299')
  })
})
