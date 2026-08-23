import { describe, it, expect } from 'vitest'

// Mirror de la garde d'abandon ajoutée le 2026-08-20 dans
// calculate-scores/index.ts (`aborted` + Promise.race per-org, cf.
// PARKING_LOT.md "churn_risk_band FAUX"). Ce fichier importe des
// spécificateurs jsr: non résolvables par Vitest (même convention que
// calculate-scores-churn.test.ts) — mirror plutôt qu'import direct.
//
// Root cause du bug corrigé : le commentaire du 2026-08-13 (P1 per-org
// isolation) notait déjà que le Promise.race "n'annule pas le travail
// abandonné" mais ne traitait comme idempotent que logger.fail() — jamais
// les écritures réelles (accountUpdateRows/historyRows) du workPromise
// abandonné, qui continuaient en arrière-plan après la résolution de la
// race. Ce mirror couvre les DEUX points de garde ajoutés dans le fichier
// réel : (1) en tête de boucle `while (batchCount < MAX_BATCHES)`, avant de
// démarrer un nouveau batch ; (2) juste avant l'upsert `accountUpdateRows`,
// pour un batch dont le scoring en mémoire a débordé le timeout pendant
// qu'il tournait.

function shouldStartNextBatch(aborted: boolean, batchCount: number, maxBatches: number): boolean {
  if (aborted) return false
  return batchCount < maxBatches
}

function shouldWriteBatch(aborted: boolean): boolean {
  return !aborted
}

describe('calculate-scores — garde d\'abandon (aborted flag)', () => {
  describe('shouldStartNextBatch — garde en tête de boucle', () => {
    it('non aborté, sous MAX_BATCHES : démarre le batch suivant', () => {
      expect(shouldStartNextBatch(false, 2, 10)).toBe(true)
    })

    it('aborté : ne démarre jamais un nouveau batch, même sous MAX_BATCHES', () => {
      expect(shouldStartNextBatch(true, 0, 10)).toBe(false)
    })

    it('non aborté mais MAX_BATCHES atteint : ne démarre pas (comportement pré-existant inchangé)', () => {
      expect(shouldStartNextBatch(false, 10, 10)).toBe(false)
    })
  })

  describe('shouldWriteBatch — garde juste avant l\'upsert accountUpdateRows', () => {
    it('non aborté : l\'écriture procède', () => {
      expect(shouldWriteBatch(false)).toBe(true)
    })

    it('aborté pendant le scoring en mémoire du batch (après le check de tête de boucle) : l\'écriture est sautée', () => {
      // Simule le cas où le timeout de 90s se déclenche PENDANT le calcul
      // en mémoire d'un batch déjà démarré (aborted passe à true après le
      // check shouldStartNextBatch mais avant l'upsert) — exactement le
      // scénario qui produisait des écritures périmées le 2026-08-15.
      expect(shouldWriteBatch(true)).toBe(false)
    })
  })

  it('séquence complète : le batch en cours au moment de l\'abandon n\'écrit pas, aucun batch suivant ne démarre', () => {
    const MAX_BATCHES = 5
    let aborted = false
    let batchCount = 0
    const batchesStarted: number[] = []
    const batchesWritten: number[] = []

    // Batch 1 : tout va bien
    if (shouldStartNextBatch(aborted, batchCount, MAX_BATCHES)) {
      batchCount++
      batchesStarted.push(batchCount)
      if (shouldWriteBatch(aborted)) batchesWritten.push(batchCount)
    }

    // Batch 2 démarre, puis le timeout se déclenche PENDANT son scoring
    if (shouldStartNextBatch(aborted, batchCount, MAX_BATCHES)) {
      batchCount++
      batchesStarted.push(batchCount)
      aborted = true // le setTimeout du Promise.race se déclenche ici, en plein calcul
      if (shouldWriteBatch(aborted)) batchesWritten.push(batchCount)
    }

    // Batch 3 ne devrait jamais démarrer
    if (shouldStartNextBatch(aborted, batchCount, MAX_BATCHES)) {
      batchCount++
      batchesStarted.push(batchCount)
    }

    expect(batchesStarted).toEqual([1, 2])
    expect(batchesWritten).toEqual([1]) // batch 2 a démarré mais n'a jamais écrit
  })
})

// Mirror de la garde de fetch-error dans prefetchScoringData — root cause
// concrète trouvée en creusant la théorie Promise.race : un échec silencieux
// de la requête subscriptions (timeout/contention DB) retombait sur `[]` via
// `?? []`, indiscernable d'un compte réellement sans subscription connue.
// isAccountChurned([]) retourne false dans les deux cas.
interface QueryResult { error: { message: string } | null }

function resolvePrefetchFetchError(results: {
  invoices12mo: QueryResult
  movements: QueryResult
  subscriptions: QueryResult
  snapshot3mo: QueryResult
  snapshot30d: QueryResult
}): string | null {
  const err =
    results.invoices12mo.error ?? results.movements.error ?? results.subscriptions.error ?? results.snapshot3mo.error ?? results.snapshot30d.error
  return err ? err.message : null
}

const OK: QueryResult = { error: null }

describe('calculate-scores — prefetchScoringData, garde fetch-error', () => {
  it('les 5 requêtes réussissent : aucune erreur, le prefetch continue normalement', () => {
    expect(
      resolvePrefetchFetchError({ invoices12mo: OK, movements: OK, subscriptions: OK, snapshot3mo: OK, snapshot30d: OK }),
    ).toBeNull()
  })

  it('la requête subscriptions échoue seule : détectée — root cause exacte du bug du 2026-08-15', () => {
    // Avant le fix, ce cas retombait silencieusement sur subscriptionsMap
    // vide, faisant lire isAccountChurned([]) === false pour un compte dont
    // l'unique subscription est en fait 'canceled'.
    const result = resolvePrefetchFetchError({
      invoices12mo: OK,
      movements: OK,
      subscriptions: { error: { message: 'canceling statement due to statement timeout' } },
      snapshot3mo: OK,
      snapshot30d: OK,
    })
    expect(result).toBe('canceling statement due to statement timeout')
  })

  it('n\'importe laquelle des 4 autres requêtes échoue : détectée aussi (pas de traitement spécial pour subscriptions seule)', () => {
    expect(
      resolvePrefetchFetchError({
        invoices12mo: { error: { message: 'connection reset' } },
        movements: OK,
        subscriptions: OK,
        snapshot3mo: OK,
        snapshot30d: OK,
      }),
    ).toBe('connection reset')
  })

  it('plusieurs échouent : la première erreur du chaîné OR gagne (ordre stable)', () => {
    expect(
      resolvePrefetchFetchError({
        invoices12mo: OK,
        movements: { error: { message: 'movements failed' } },
        subscriptions: { error: { message: 'subscriptions failed' } },
        snapshot3mo: OK,
        snapshot30d: OK,
      }),
    ).toBe('movements failed')
  })
})
