import { describe, it, expect } from 'vitest'
import { estimateInvoiceOnlyMrr, type InvoiceOnlyMrrInput } from '../functions/_shared/mrr-engine'

// Mirror de la boucle de décision dans sync-stripe/index.ts::syncInvoices
// (mission réconciliation Stripe, point 4, 2026-08-20) — ce fichier importe
// des spécificateurs jsr: en position valeur, non résolvables par Vitest,
// même convention que sync-stripe-quota.test.ts. `estimateInvoiceOnlyMrr`
// lui-même est déjà testé directement (import réel, mrr-engine.test.ts) —
// ce mirror couvre uniquement la boucle qui décide, par compte
// invoice-only, si le résultat de l'estimation doit être écrit tel quel,
// écarté pour devise minoritaire, ou laissé inchangé (aucune estimation
// possible).

interface AccountMrrUpdateRow {
  id: string
  mrr_cents?: number
  arr_cents?: number
  mrr_status: 'ok' | 'unavailable'
  mrr_unavailable_reason: 'no_subscription_data' | 'unsupported_pricing' | 'currency_mismatch' | null
}

function buildInvoiceOnlyMrrUpdateRows(
  invoiceOnlyAccountIds: string[],
  paidByAccount: Map<string, InvoiceOnlyMrrInput[]>,
  orgMajorityCurrency: string | null,
): { rows: AccountMrrUpdateRow[]; estimatedCount: number; currencyMismatchCount: number } {
  const rows: AccountMrrUpdateRow[] = []
  let currencyMismatchCount = 0

  for (const accountId of invoiceOnlyAccountIds) {
    const estimate = estimateInvoiceOnlyMrr(paidByAccount.get(accountId) ?? [])
    if (!estimate) continue
    if (orgMajorityCurrency !== null && estimate.currency !== null && estimate.currency !== orgMajorityCurrency) {
      currencyMismatchCount++
      rows.push({ id: accountId, mrr_status: 'unavailable', mrr_unavailable_reason: 'currency_mismatch' })
      continue
    }
    rows.push({
      id: accountId,
      mrr_cents: estimate.mrr_cents,
      arr_cents: estimate.mrr_cents * 12,
      mrr_status: 'ok',
      mrr_unavailable_reason: null,
    })
  }

  return { rows, estimatedCount: rows.length - currencyMismatchCount, currencyMismatchCount }
}

const NOW_ISO_RECENT = '2026-08-15T00:00:00Z'
const NOW_ISO_RECENT_MINUS_30D = '2026-07-16T00:00:00Z'

describe('sync-stripe invoice-only MRR fallback — decision loop', () => {
  it('an account with 2 recent paid invoices at a monthly cadence gets mrr_status=ok', () => {
    const paidByAccount = new Map<string, InvoiceOnlyMrrInput[]>([
      ['acc-1', [
        { amountCents: 29900, currency: 'usd', paidAt: NOW_ISO_RECENT },
        { amountCents: 29900, currency: 'usd', paidAt: NOW_ISO_RECENT_MINUS_30D },
      ]],
    ])
    const { rows, estimatedCount } = buildInvoiceOnlyMrrUpdateRows(['acc-1'], paidByAccount, 'usd')
    expect(estimatedCount).toBe(1)
    expect(rows[0].mrr_status).toBe('ok')
    expect(rows[0].mrr_unavailable_reason).toBeNull()
    expect(rows[0].mrr_cents).toBeGreaterThan(0)
  })

  it('an account with only 1 paid invoice is left out entirely — no row written, stays unavailable/no_subscription_data as-is', () => {
    const paidByAccount = new Map<string, InvoiceOnlyMrrInput[]>([
      ['acc-1', [{ amountCents: 29900, currency: 'usd', paidAt: NOW_ISO_RECENT }]],
    ])
    const { rows, estimatedCount } = buildInvoiceOnlyMrrUpdateRows(['acc-1'], paidByAccount, 'usd')
    expect(rows).toHaveLength(0)
    expect(estimatedCount).toBe(0)
  })

  it('an account with zero paid invoices (in paidByAccount at all) is left out', () => {
    const { rows } = buildInvoiceOnlyMrrUpdateRows(['acc-1'], new Map(), 'usd')
    expect(rows).toHaveLength(0)
  })

  it('a minority-currency invoice-only account is explicitly marked currency_mismatch, never estimated', () => {
    const paidByAccount = new Map<string, InvoiceOnlyMrrInput[]>([
      ['acc-1', [
        { amountCents: 500000, currency: 'jpy', paidAt: NOW_ISO_RECENT },
        { amountCents: 500000, currency: 'jpy', paidAt: NOW_ISO_RECENT_MINUS_30D },
      ]],
    ])
    const { rows, estimatedCount, currencyMismatchCount } = buildInvoiceOnlyMrrUpdateRows(['acc-1'], paidByAccount, 'usd')
    expect(estimatedCount).toBe(0)
    expect(currencyMismatchCount).toBe(1)
    expect(rows[0].mrr_status).toBe('unavailable')
    expect(rows[0].mrr_unavailable_reason).toBe('currency_mismatch')
    expect(rows[0].mrr_cents).toBeUndefined() // jamais un montant dans une devise non-agrégable
  })

  it('orgMajorityCurrency=null (no subscriptions to vote a majority from) never blocks an estimate on currency grounds', () => {
    const paidByAccount = new Map<string, InvoiceOnlyMrrInput[]>([
      ['acc-1', [
        { amountCents: 29900, currency: 'eur', paidAt: NOW_ISO_RECENT },
        { amountCents: 29900, currency: 'eur', paidAt: NOW_ISO_RECENT_MINUS_30D },
      ]],
    ])
    const { rows, estimatedCount } = buildInvoiceOnlyMrrUpdateRows(['acc-1'], paidByAccount, null)
    expect(estimatedCount).toBe(1)
    expect(rows[0].mrr_status).toBe('ok')
  })

  it('handles a mixed batch — one estimable, one insufficient data, one currency mismatch', () => {
    const paidByAccount = new Map<string, InvoiceOnlyMrrInput[]>([
      ['acc-ok', [
        { amountCents: 29900, currency: 'usd', paidAt: NOW_ISO_RECENT },
        { amountCents: 29900, currency: 'usd', paidAt: NOW_ISO_RECENT_MINUS_30D },
      ]],
      ['acc-insufficient', [{ amountCents: 9900, currency: 'usd', paidAt: NOW_ISO_RECENT }]],
      ['acc-mismatch', [
        { amountCents: 500000, currency: 'jpy', paidAt: NOW_ISO_RECENT },
        { amountCents: 500000, currency: 'jpy', paidAt: NOW_ISO_RECENT_MINUS_30D },
      ]],
    ])
    const { rows, estimatedCount, currencyMismatchCount } = buildInvoiceOnlyMrrUpdateRows(
      ['acc-ok', 'acc-insufficient', 'acc-mismatch'],
      paidByAccount,
      'usd',
    )
    expect(estimatedCount).toBe(1)
    expect(currencyMismatchCount).toBe(1)
    expect(rows).toHaveLength(2) // acc-insufficient never produces a row at all
    expect(rows.find((r) => r.id === 'acc-ok')?.mrr_status).toBe('ok')
    expect(rows.find((r) => r.id === 'acc-mismatch')?.mrr_status).toBe('unavailable')
  })
})
