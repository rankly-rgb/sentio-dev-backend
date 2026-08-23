import { describe, expect, it } from 'vitest'

// Mirror de prefetchScoringData's chunking (calculate-scores/index.ts) — root
// cause trouvée le 2026-08-23 en re-scorant l'org "test" (432 comptes) : un
// seul appel `.in('account_id', accountIds)` avec les 432 ids échoue de
// façon reproductible ("http2 error: stream error detected: unspecific
// protocol error detected", 2 tentatives identiques, pas un flake). Le fix
// chunke accountIds par PREFETCH_CHUNK_SIZE avant chacune des 5 requêtes
// bulk, puis fusionne les résultats — ces mirrors couvrent la logique de
// découpage et de résolution d'erreur multi-chunk, `index.ts` ayant des
// imports jsr: non résolvables sous Vitest (même convention que les autres
// tests calculate-scores-*.test.ts).

const PREFETCH_CHUNK_SIZE = 150

function chunkAccountIds(accountIds: string[]): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < accountIds.length; i += PREFETCH_CHUNK_SIZE) {
    chunks.push(accountIds.slice(i, i + PREFETCH_CHUNK_SIZE))
  }
  return chunks
}

function makeIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `acct-${i}`)
}

describe('calculate-scores — prefetchScoringData, chunkAccountIds', () => {
  it('0 compte : aucun chunk', () => {
    expect(chunkAccountIds([])).toEqual([])
  })

  it('moins d\'un chunk plein : 1 seul chunk', () => {
    expect(chunkAccountIds(makeIds(3))).toEqual([['acct-0', 'acct-1', 'acct-2']])
  })

  it('exactement PREFETCH_CHUNK_SIZE comptes : 1 seul chunk plein', () => {
    const chunks = chunkAccountIds(makeIds(150))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toHaveLength(150)
  })

  it('un compte de plus que PREFETCH_CHUNK_SIZE : 2 chunks (150 + 1)', () => {
    const chunks = chunkAccountIds(makeIds(151))
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toHaveLength(150)
    expect(chunks[1]).toHaveLength(1)
  })

  it('432 comptes (org "test", cas réel du 2026-08-23) : 3 chunks (150 + 150 + 132)', () => {
    const chunks = chunkAccountIds(makeIds(432))
    expect(chunks).toHaveLength(3)
    expect(chunks.map((c) => c.length)).toEqual([150, 150, 132])
  })

  it('chaque compte apparaît dans exactement un chunk, dans l\'ordre d\'origine', () => {
    const ids = makeIds(320)
    const chunks = chunkAccountIds(ids)
    expect(chunks.flat()).toEqual(ids)
  })
})

// Mirror de la résolution d'erreur multi-chunk : chaque chunk lance les 5
// mêmes requêtes qu'avant (invoices/movements/subscriptions/snapshot3mo/
// snapshot30d) — la première erreur rencontrée, tous chunks et toutes
// requêtes confondus dans l'ordre de génération, doit encore faire échouer
// tout le prefetch (même garde qu'avant le chunking, cf.
// calculate-scores-abandoned-work-guard.test.ts::resolvePrefetchFetchError
// pour le cas mono-chunk).
interface QueryResult { error: { message: string } | null; data: unknown[] | null }

const OK: QueryResult = { error: null, data: [] }

function errorOf(message: string): QueryResult {
  return { error: { message }, data: null }
}

function resolveChunkedFetchError(
  chunkResults: Array<[QueryResult, QueryResult, QueryResult, QueryResult, QueryResult]>,
): string | null {
  const err = chunkResults
    .flatMap(([invoicesRes, movementsRes, subscriptionsRes, snapshot3moRes, snapshot30dRes]) => [
      invoicesRes.error,
      movementsRes.error,
      subscriptionsRes.error,
      snapshot3moRes.error,
      snapshot30dRes.error,
    ])
    .find((e) => e != null)
  return err ? err.message : null
}

describe('calculate-scores — prefetchScoringData, résolution d\'erreur multi-chunk', () => {
  it('tous les chunks réussissent : aucune erreur', () => {
    const chunkResults: Array<[QueryResult, QueryResult, QueryResult, QueryResult, QueryResult]> = [
      [OK, OK, OK, OK, OK],
      [OK, OK, OK, OK, OK],
    ]
    expect(resolveChunkedFetchError(chunkResults)).toBeNull()
  })

  it('une requête échoue dans le 2e chunk : l\'erreur remonte (le prefetch entier doit throw)', () => {
    const chunkResults: Array<[QueryResult, QueryResult, QueryResult, QueryResult, QueryResult]> = [
      [OK, OK, OK, OK, OK],
      [OK, OK, errorOf('subscriptions query timeout'), OK, OK],
    ]
    expect(resolveChunkedFetchError(chunkResults)).toBe('subscriptions query timeout')
  })

  it('des erreurs dans plusieurs chunks : la première dans l\'ordre (chunk, puis requête) gagne', () => {
    const chunkResults: Array<[QueryResult, QueryResult, QueryResult, QueryResult, QueryResult]> = [
      [OK, errorOf('movements chunk 1'), OK, OK, OK],
      [OK, OK, errorOf('subscriptions chunk 2'), OK, OK],
    ]
    expect(resolveChunkedFetchError(chunkResults)).toBe('movements chunk 1')
  })

  it('un seul chunk (batch sous PREFETCH_CHUNK_SIZE) : se comporte comme la garde mono-chunk pré-existante', () => {
    const chunkResults: Array<[QueryResult, QueryResult, QueryResult, QueryResult, QueryResult]> = [
      [OK, OK, OK, OK, errorOf('snapshot30d failed')],
    ]
    expect(resolveChunkedFetchError(chunkResults)).toBe('snapshot30d failed')
  })
})

// Mirror de la fusion des lignes par requête (flatMap sur chunkResults) —
// chaque compte n'apparaissant que dans un seul chunk, la fusion doit
// préserver l'ordre interne des lignes de ce compte (important pour
// mrr3moAgoMap/healthScore30dAgoMap, qui ne retiennent que le PREMIER
// snapshot dans la fenêtre grâce à l'ORDER BY snapshot_date ascending —
// un chunking par accountIds, jamais par plage de dates, ne peut pas
// scinder les lignes d'un même compte entre deux chunks).
describe('calculate-scores — prefetchScoringData, fusion des lignes entre chunks', () => {
  it('les lignes de chaque chunk sont concaténées, ordre interne par compte préservé', () => {
    interface Row { account_id: string; snapshot_date: string }
    const chunk1Rows: Row[] = [
      { account_id: 'acct-a', snapshot_date: '2026-05-01' },
      { account_id: 'acct-a', snapshot_date: '2026-05-15' },
    ]
    const chunk2Rows: Row[] = [
      { account_id: 'acct-b', snapshot_date: '2026-05-03' },
    ]
    const merged = [chunk1Rows, chunk2Rows].flatMap((rows) => rows)
    expect(merged).toEqual([
      { account_id: 'acct-a', snapshot_date: '2026-05-01' },
      { account_id: 'acct-a', snapshot_date: '2026-05-15' },
      { account_id: 'acct-b', snapshot_date: '2026-05-03' },
    ])

    // "premier snapshot par compte" doit toujours résoudre à la ligne la
    // plus ancienne de ce compte, peu importe la présence d'un autre compte
    // dans un chunk différent.
    const firstByAccount = new Map<string, string>()
    for (const row of merged) {
      if (!firstByAccount.has(row.account_id)) firstByAccount.set(row.account_id, row.snapshot_date)
    }
    expect(firstByAccount.get('acct-a')).toBe('2026-05-01')
    expect(firstByAccount.get('acct-b')).toBe('2026-05-03')
  })
})
