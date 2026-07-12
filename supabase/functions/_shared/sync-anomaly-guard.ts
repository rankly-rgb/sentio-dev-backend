// Détection d'anomalie sur les runs de sync-stripe : un run qui ferait
// passer une part anormale de comptes à mrr_cents=0 en une seule fois est
// la signature d'un sync cassé (cf. incident documenté : -55,3% de MRR en
// quelques jours, tous les comptes à 0€ en même temps). Détection
// unidirectionnelle (chute uniquement) — pas de signal pour une hausse.

export interface AccountMrrUpdate {
  id: string
  mrr_cents: number
}

export interface AnomalyCheckResult {
  affectedCount: number
  totalCount: number
  ratio: number
  isAnomaly: boolean
}

const ANOMALY_RATIO_THRESHOLD = 0.15
const ANOMALY_MIN_AFFECTED = 5

export function detectMrrCollapseAnomaly(
  prevMrrByAccount: Map<string, number>,
  accountUpdateRows: AccountMrrUpdate[],
): AnomalyCheckResult {
  let affectedCount = 0
  for (const row of accountUpdateRows) {
    const prev = prevMrrByAccount.get(row.id) ?? 0
    if (prev > 0 && row.mrr_cents === 0) affectedCount++
  }
  const totalCount = accountUpdateRows.length
  const ratio = totalCount > 0 ? affectedCount / totalCount : 0
  const isAnomaly = affectedCount >= ANOMALY_MIN_AFFECTED && ratio > ANOMALY_RATIO_THRESHOLD
  return { affectedCount, totalCount, ratio, isAnomaly }
}
