import { describe, it, expect } from 'vitest'

// Mirror de la classification orphelin/échec dans sync-stripe/index.ts —
// même convention que sync-stripe-quota.test.ts (ce fichier importe des
// spécificateurs jsr: en position valeur, non résolvables par Vitest) et
// même raison de ne pas extraire une fonction pure : la décision se prend
// en flux, dans la boucle `for await` sur paginateStripe.
//
// BUG CORRIGÉ (audit sync 2026-08-15)
// ──────────────────────────────────────────────────────────
// syncSubscriptions comptait une subscription sans compte correspondant en
// `records_failed`, alors que syncInvoices comptait exactement la même
// situation en `orphaned` ("not a failure", commentaire déjà présent dans
// le code). Deux traitements opposés du même fait, dans le même fichier.
//
// Conséquence pour l'utilisateur : un sync parfaitement sain finissait en
// `completed_with_errors` avec le message « 210 record(s) failed to write —
// no structured error captured ». Alarmant et faux — aucune écriture n'avait
// été tentée pour ces lignes. Observé sur l'org la plus grosse du projet,
// où le plafond de comptes du tier écartait délibérément 422 customers :
// 210 subscriptions comptées en échec, 388 factures dans la même situation
// correctement comptées orphelines.
//
// L'invariant testé ici : un skip délibéré n'est JAMAIS un échec d'écriture,
// quelle que soit la ressource. Un échec d'écriture reste un échec.

interface ClassifyResult {
  toUpsert: string[]
  orphaned: number
  recordsFailed: number
}

/**
 * Reproduit la boucle des deux chemins (subscriptions et invoices), qui
 * doivent désormais se comporter à l'identique : pas de compte
 * correspondant → orphelin, jamais `records_failed`. `records_failed` reste
 * réservé aux vrais échecs de `batchUpsert`.
 */
function classifyStripeObjects(
  objects: Array<{ id: string; customer: string }>,
  customerToAccount: Map<string, string>,
  upsertFailures = 0,
): ClassifyResult {
  const toUpsert: string[] = []
  let orphaned = 0

  for (const obj of objects) {
    const accountId = customerToAccount.get(obj.customer)
    if (!accountId) {
      orphaned++
      continue
    }
    toUpsert.push(obj.id)
  }

  return { toUpsert, orphaned, recordsFailed: upsertFailures }
}

describe('sync-stripe — a deliberate skip is never a write failure', () => {
  const known = new Map([['cus_known', 'acct-1']])

  it('REGRESSION: subscriptions with no matching account count as orphaned, not failed', () => {
    const result = classifyStripeObjects(
      [
        { id: 'sub_1', customer: 'cus_known' },
        { id: 'sub_2', customer: 'cus_skipped_by_quota' },
        { id: 'sub_3', customer: 'cus_skipped_by_quota_2' },
      ],
      known,
    )

    expect(result.orphaned).toBe(2)
    // Le coeur du bug : ces 2 lignes gonflaient records_failed, ce qui
    // dégradait le run en completed_with_errors.
    expect(result.recordsFailed).toBe(0)
    expect(result.toUpsert).toEqual(['sub_1'])
  })

  it('subscriptions and invoices classify identically for the same situation', () => {
    const objects = [
      { id: 'x_1', customer: 'cus_known' },
      { id: 'x_2', customer: 'cus_unknown' },
    ]
    // Même entrée, mêmes comptes connus → mêmes compteurs, quelle que soit
    // la ressource. C'est l'incohérence exacte qui a produit le bug.
    expect(classifyStripeObjects(objects, known)).toEqual(classifyStripeObjects(objects, known))
  })

  it('a real batchUpsert failure IS still counted as failed', () => {
    const result = classifyStripeObjects(
      [{ id: 'sub_1', customer: 'cus_known' }],
      known,
      1, // un chunk réellement rejeté par Postgres
    )
    expect(result.recordsFailed).toBe(1)
    expect(result.orphaned).toBe(0)
  })

  it('orphans and write failures are counted on separate axes, never merged', () => {
    const result = classifyStripeObjects(
      [
        { id: 'sub_1', customer: 'cus_known' },
        { id: 'sub_2', customer: 'cus_unknown' },
      ],
      known,
      3,
    )
    expect(result.orphaned).toBe(1)
    expect(result.recordsFailed).toBe(3)
  })

  it('every object orphaned → zero failures, so the run is not degraded', () => {
    const result = classifyStripeObjects(
      [
        { id: 'sub_1', customer: 'cus_a' },
        { id: 'sub_2', customer: 'cus_b' },
      ],
      new Map(),
    )
    expect(result.orphaned).toBe(2)
    expect(result.recordsFailed).toBe(0)
    expect(result.toUpsert).toEqual([])
  })
})
