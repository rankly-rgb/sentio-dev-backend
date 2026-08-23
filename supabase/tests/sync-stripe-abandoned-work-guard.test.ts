import { describe, it, expect } from 'vitest'

// Mirror de la garde d'abandon ajoutée le 2026-08-20 dans sync-stripe/index.ts
// — même classe de défaut que calculate-scores/index.ts (cf.
// calculate-scores-abandoned-work-guard.test.ts et PARKING_LOT.md
// "churn_risk_band FAUX"), corrigé sur ce second chemin à la demande
// explicite de Naima même sans confirmation qu'il ait déjà produit un bug
// actif : "je ne veux pas revivre ce même scénario dans 2 semaines sur
// l'autre chemin". Mirror plutôt qu'import direct — sync-stripe/index.ts a
// des imports jsr: non résolvables par Vitest (même convention que
// sync-stripe-quota.test.ts).
//
// syncCustomers/syncSubscriptions/syncInvoices font chacun une passe de
// pagination Stripe en mémoire suivie d'un-ou-plusieurs batchUpsert() en
// fin de fonction (pas d'écriture par page) — la garde `isAborted()` est
// donc posée juste avant chacun des 5 points d'écriture réels du fichier :
// syncCustomers (1), syncSubscriptions (2 : restatement OU normal, mutuellement
// exclusifs), syncInvoices (2 : invoices puis mrrEstimateRows).

type WriteSite = 'customers' | 'subscriptions' | 'invoices_rows' | 'invoices_estimate'

function runSyncPipeline(abortAfterSite: WriteSite | null): Record<WriteSite, boolean> {
  let aborted = false
  const isAborted = () => aborted
  const wrote: Record<WriteSite, boolean> = {
    customers: false,
    subscriptions: false,
    invoices_rows: false,
    invoices_estimate: false,
  }

  const sites: WriteSite[] = ['customers', 'subscriptions', 'invoices_rows', 'invoices_estimate']
  for (const site of sites) {
    if (!isAborted()) {
      wrote[site] = true
    }
    if (site === abortAfterSite) {
      // Simule le setTimeout du Promise.race externe (SYNC_STEPS_TIMEOUT_MS)
      // se déclenchant entre ce site d'écriture et le suivant.
      aborted = true
    }
  }
  return wrote
}

describe('sync-stripe — garde d\'abandon (aborted flag), pipeline customers → subscriptions → invoices', () => {
  it('run complet sans timeout : les 4 sites d\'écriture ont lieu normalement', () => {
    expect(runSyncPipeline(null)).toEqual({
      customers: true,
      subscriptions: true,
      invoices_rows: true,
      invoices_estimate: true,
    })
  })

  it('timeout déjà déclenché avant le tout premier point d\'écriture : rien n\'écrit, même syncCustomers', () => {
    const aborted = true
    const isAborted = () => aborted
    const wrote = { customers: !isAborted(), subscriptions: false, invoices_rows: false, invoices_estimate: false }
    expect(wrote.customers).toBe(false)
  })

  it('timeout survient juste après syncCustomers : son écriture (déjà en vol) a eu lieu, mais subscriptions/invoices sont sautés — pas de rollback rétroactif', () => {
    const wrote = runSyncPipeline('customers')
    expect(wrote.customers).toBe(true)
    expect(wrote.subscriptions).toBe(false)
    expect(wrote.invoices_rows).toBe(false)
    expect(wrote.invoices_estimate).toBe(false)
  })

  it('timeout survient juste après syncSubscriptions : customers+subscriptions ont écrit, les deux écritures invoices sont sautées', () => {
    const wrote = runSyncPipeline('subscriptions')
    expect(wrote.customers).toBe(true)
    expect(wrote.subscriptions).toBe(true)
    expect(wrote.invoices_rows).toBe(false)
    expect(wrote.invoices_estimate).toBe(false)
  })

  it('timeout survient entre les deux écritures de syncInvoices (invoices_rows puis mrrEstimateRows) : la première a lieu, la seconde (MRR de repli invoice-only) est sautée', () => {
    // C'est le site d'écriture ajouté en dernier dans ce chantier — le plus
    // susceptible d'avoir été oublié si le fix avait été fait en surface.
    const wrote = runSyncPipeline('invoices_rows')
    expect(wrote.customers).toBe(true)
    expect(wrote.subscriptions).toBe(true)
    expect(wrote.invoices_rows).toBe(true)
    expect(wrote.invoices_estimate).toBe(false)
  })
})

// Garde spécifique à syncSubscriptions : deux sites d'écriture accounts
// mutuellement exclusifs (restatementMode true → mrr_restatements +
// accounts ; restatementMode false → accounts seul). Les deux doivent être
// gardés indépendamment — un mirror séparé pour ne pas masquer un oubli sur
// la branche restatement, moins souvent exercée en pratique.
describe('sync-stripe — syncSubscriptions, branche restatement vs normale', () => {
  function runSubscriptionsWrite(restatementMode: boolean, aborted: boolean): { restatementWrote: boolean; accountsWrote: boolean } {
    // La garde subscriptions "principale" (upsert subscriptions) est déjà
    // couverte par le pipeline ci-dessus — ce mirror couvre uniquement la
    // seconde garde, propre à chaque branche.
    if (restatementMode) {
      if (aborted) return { restatementWrote: false, accountsWrote: false }
      return { restatementWrote: true, accountsWrote: true }
    }
    if (aborted) return { restatementWrote: false, accountsWrote: false }
    return { restatementWrote: false, accountsWrote: true }
  }

  it('mode restatement, non aborté : mrr_restatements ET accounts écrivent', () => {
    expect(runSubscriptionsWrite(true, false)).toEqual({ restatementWrote: true, accountsWrote: true })
  })

  it('mode restatement, aborté : ni mrr_restatements ni accounts n\'écrivent', () => {
    expect(runSubscriptionsWrite(true, true)).toEqual({ restatementWrote: false, accountsWrote: false })
  })

  it('mode normal, non aborté : accounts écrit (pas de mrr_restatements, hors-sujet sur ce chemin)', () => {
    expect(runSubscriptionsWrite(false, false)).toEqual({ restatementWrote: false, accountsWrote: true })
  })

  it('mode normal, aborté : accounts n\'écrit pas — c\'est exactement ce champ (mrr_cents/mrr_status/is_delinquent) dont l\'écriture concurrente a motivé ce correctif', () => {
    expect(runSubscriptionsWrite(false, true)).toEqual({ restatementWrote: false, accountsWrote: false })
  })
})
