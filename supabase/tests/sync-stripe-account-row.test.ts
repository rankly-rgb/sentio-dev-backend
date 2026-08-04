import { describe, it, expect } from 'vitest'

// Mirror de la construction de ligne `accountUpdateRows` dans
// sync-stripe/index.ts (syncSubscriptions) — ce fichier importe des
// spécificateurs jsr: en position valeur (Deno.serve, EdgeRuntime, etc.),
// non résolvables par Vitest, même convention que
// calculate-scores-churn.test.ts.
//
// Incident 2026-08-04 (IMPLEMENTATION_LOG.md) : `batchUpsert()` envoie
// tout un batch de comptes en un seul appel `.upsert(chunk, {onConflict})`.
// PostgREST doit unifier la liste de colonnes de l'INSERT sur le batch
// entier — une ligne où une clé est absente reçoit un NULL explicite pour
// cette colonne (pas le DEFAULT de la table, qui ne s'applique que si la
// colonne est absente de la liste de colonnes de TOUT l'INSERT). Une seule
// ligne en défaut sur une colonne NOT NULL fait échouer le batch entier.
// `billing_model` (NOT NULL, DEFAULT 'subscription') était assignée
// conditionnellement — les comptes sans subscription ce run recevaient une
// ligne SANS cette clé, cassant tout le batch. Ce test reproduit le
// mécanisme exact avec les deux versions du builder.

const ACCOUNTS_NOT_NULL_COLUMNS = [
  'mrr_cents', 'arr_cents', 'trial_mrr_cents', 'mrr_status',
  'is_delinquent', 'pending_cancellation', 'is_zero_dollar_active', 'billing_model',
] as const

interface AccountAgg {
  mrr_cents: number
  trial_mrr_cents: number
  mrr_status: 'ok' | 'unavailable'
  is_delinquent: boolean
  pending_cancellation: boolean
  is_zero_dollar_active: boolean
  currency: string | null
}

// Ancien builder (bug) — conservé uniquement pour prouver la régression.
function buildAccountRowBuggy(acctId: string, agg: AccountAgg, hasSubscriptionThisRun: boolean): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: acctId,
    mrr_cents: agg.mrr_cents,
    arr_cents: agg.mrr_cents * 12,
    trial_mrr_cents: agg.trial_mrr_cents,
    mrr_status: agg.mrr_status,
    is_delinquent: agg.is_delinquent,
    pending_cancellation: agg.pending_cancellation,
    is_zero_dollar_active: agg.is_zero_dollar_active,
  }
  if (agg.currency) row.currency = agg.currency
  if (hasSubscriptionThisRun) row.billing_model = 'subscription'
  return row
}

// Nouveau builder (fixé) — mirror de la forme canonique de sync-stripe/index.ts.
function buildAccountRowFixed(acctId: string, agg: AccountAgg): Record<string, unknown> {
  return {
    id: acctId,
    mrr_cents: agg.mrr_cents,
    arr_cents: agg.mrr_cents * 12,
    trial_mrr_cents: agg.trial_mrr_cents,
    mrr_status: agg.mrr_status,
    is_delinquent: agg.is_delinquent,
    pending_cancellation: agg.pending_cancellation,
    is_zero_dollar_active: agg.is_zero_dollar_active,
    currency: agg.currency ?? null,
    billing_model: 'subscription',
  }
}

function hasUniformKeys(rows: Array<Record<string, unknown>>): boolean {
  if (rows.length === 0) return true
  const first = Object.keys(rows[0]).sort().join(',')
  return rows.every((r) => Object.keys(r).sort().join(',') === first)
}

function missingNotNullColumn(rows: Array<Record<string, unknown>>): boolean {
  return rows.some((r) => ACCOUNTS_NOT_NULL_COLUMNS.some((col) => !(col in r) || r[col] === undefined))
}

const baseAgg: AccountAgg = {
  mrr_cents: 5000,
  trial_mrr_cents: 0,
  mrr_status: 'ok',
  is_delinquent: false,
  pending_cancellation: false,
  is_zero_dollar_active: false,
  currency: 'usd',
}

describe('sync-stripe accountUpdateRows — régression hétérogénéité de batch (incident 2026-08-04)', () => {
  it('REGRESSION: l\'ancien builder produit un batch hétérogène dès que des comptes diffèrent sur la présence d\'une subscription ce run', () => {
    const rows = [
      buildAccountRowBuggy('acct-with-sub', baseAgg, true),
      buildAccountRowBuggy('acct-no-sub-this-run', baseAgg, false),
    ]
    // C'est exactement le défaut trouvé : dans le MÊME appel batchUpsert(),
    // une ligne porte billing_model, l'autre non — Postgres rejette le
    // batch entier sur la violation NOT NULL de la seconde ligne.
    expect(hasUniformKeys(rows)).toBe(false)
    expect(missingNotNullColumn(rows)).toBe(true)
  })

  it('le nouveau builder produit toujours un jeu de clés uniforme sur un batch mixte (avec/sans subscription, avec/sans devise)', () => {
    const rows = [
      buildAccountRowFixed('acct-with-sub', baseAgg),
      buildAccountRowFixed('acct-no-sub-this-run', baseAgg),
      buildAccountRowFixed('acct-no-currency', { ...baseAgg, currency: null }),
    ]
    expect(hasUniformKeys(rows)).toBe(true)
    expect(missingNotNullColumn(rows)).toBe(false)
  })

  it('le nouveau builder ne omet jamais billing_model, même pour un compte sans subscription ce run', () => {
    const row = buildAccountRowFixed('acct-no-sub-this-run', baseAgg)
    expect(row.billing_model).toBe('subscription')
    expect('billing_model' in row).toBe(true)
  })

  it('currency reste explicite (null) plutôt qu\'absente quand non résolue — colonne nullable, mais la forme canonique l\'exige aussi', () => {
    const row = buildAccountRowFixed('acct-no-currency', { ...baseAgg, currency: null })
    expect('currency' in row).toBe(true)
    expect(row.currency).toBeNull()
  })
})
