import { describe, it, expect } from 'vitest'

// Mirror de la décision de plafond dans sync-stripe/index.ts::syncCustomers
// — ce fichier importe des spécificateurs jsr: en position valeur
// (Deno.serve, EdgeRuntime, etc.), non résolvables par Vitest, même
// convention que sync-stripe-account-row.test.ts. Pas d'extraction en
// fonction pure partagée ici (contrairement à trial-status.ts/
// calcMrrGrowthMetrics) : la vraie décision se prend en flux, dans la
// boucle `for await` sur paginateStripe — matérialiser la liste complète
// des clients à l'avance pour appeler une fonction pure séparée doublerait
// les appels à l'API Stripe /customers (une passe pour décider, une pour
// construire les lignes), un coût réel pour un simple gain de testabilité.
//
// Chantier billing (2026-08-13) : `is_over_limit` (subscription-status)
// était affiché mais jamais appliqué — un org Free (30 comptes) pouvait en
// tracker des milliers. Ce mirror reproduit la boucle exacte : les comptes
// déjà trackés (existingIds) ne sont JAMAIS soumis au plafond, seule la
// croissance (nouveaux stripe_customer_id) l'est.

function selectAccountsWithinQuota(
  customerIds: string[],
  existingIds: Set<string>,
  existingCount: number,
  maxAccounts: number | null,
): { syncedIds: string[]; skippedCount: number } {
  let remainingSlots = maxAccounts === null ? Infinity : Math.max(0, maxAccounts - existingCount)
  const syncedIds: string[] = []
  let skippedCount = 0

  for (const id of customerIds) {
    if (existingIds.has(id)) {
      syncedIds.push(id)
      continue
    }
    if (remainingSlots <= 0) {
      skippedCount++
      continue
    }
    remainingSlots--
    syncedIds.push(id)
  }

  return { syncedIds, skippedCount }
}

describe('sync-stripe quota — croissance plafonnée, comptes existants jamais gelés', () => {
  it('sous le plafond : tous les nouveaux clients sont synchronisés', () => {
    const result = selectAccountsWithinQuota(['cus_1', 'cus_2', 'cus_3'], new Set(), 0, 30)
    expect(result.syncedIds).toEqual(['cus_1', 'cus_2', 'cus_3'])
    expect(result.skippedCount).toBe(0)
  })

  it('au-dessus du plafond : les nouveaux clients au-delà de la capacité restante sont exclus, jamais silencieusement', () => {
    // 28 comptes déjà trackés, plafond 30 → 2 slots restants pour 5 nouveaux clients
    const result = selectAccountsWithinQuota(
      ['cus_1', 'cus_2', 'cus_3', 'cus_4', 'cus_5'],
      new Set(),
      28,
      30,
    )
    expect(result.syncedIds).toEqual(['cus_1', 'cus_2'])
    expect(result.skippedCount).toBe(3)
  })

  it('déjà au plafond (existingCount >= max) : aucun nouveau client accepté', () => {
    const result = selectAccountsWithinQuota(['cus_1', 'cus_2'], new Set(), 30, 30)
    expect(result.syncedIds).toEqual([])
    expect(result.skippedCount).toBe(2)
  })

  it('un compte DÉJÀ trackés n\'est jamais compté contre le plafond, même à capacité pleine', () => {
    // 30/30 déjà atteint, mais cus_existing est déjà un compte connu : doit
    // toujours être re-synchronisé (mise à jour), jamais gelé.
    const result = selectAccountsWithinQuota(
      ['cus_existing', 'cus_new'],
      new Set(['cus_existing']),
      30,
      30,
    )
    expect(result.syncedIds).toEqual(['cus_existing'])
    expect(result.skippedCount).toBe(1)
  })

  it('max_accounts null (Enterprise) : jamais de plafond, quel que soit existingCount', () => {
    const manyNewCustomers = Array.from({ length: 500 }, (_, i) => `cus_${i}`)
    const result = selectAccountsWithinQuota(manyNewCustomers, new Set(), 10_000, null)
    expect(result.syncedIds).toHaveLength(500)
    expect(result.skippedCount).toBe(0)
  })

  it('mélange comptes existants et nouveaux, plafond serré : les existants passent tous, les nouveaux sont plafonnés indépendamment de leur ordre', () => {
    const existing = new Set(['cus_a', 'cus_b'])
    const result = selectAccountsWithinQuota(
      ['cus_a', 'cus_new1', 'cus_b', 'cus_new2', 'cus_new3'],
      existing,
      2, // existingCount = taille de `existing`
      3, // plafond 3 → 1 slot restant pour les nouveaux
    )
    expect(result.syncedIds).toEqual(['cus_a', 'cus_new1', 'cus_b'])
    expect(result.skippedCount).toBe(2)
  })
})
