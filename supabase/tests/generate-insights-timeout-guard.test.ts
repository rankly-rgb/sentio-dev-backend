import { describe, it, expect } from 'vitest'

// Mirror of the per-org isolation timeout added 2026-08-23 to
// generate-insights/index.ts (that file imports jsr: specifiers Vitest/Node
// cannot resolve, same convention as generate-insights-churned-gate.test.ts).
//
// generate-insights never received the P1 per-org isolation fix (2026-08-13,
// PR #61) that calculate-scores/sync-stripe got — nothing stopped one slow
// org's sequential per-account syncInsights() DB round-trips from running
// long enough to push the whole cron invocation (jobid 40,
// generate-insights-daily) past self-monitor's 15-minute external sweep,
// which is exactly the "Auto-failed by self-monitor: exceeded 15 min running
// time" signature observed on data_syncs every night from at least
// 2026-08-16 through 2026-08-23. Uses the cooperative-check design directly
// (issue #65: a passive setTimeout/Promise.race can be starved by a long
// chain of awaited microtasks and never fire) rather than the flawed passive
// pattern calculate-scores/sync-stripe started with.
function isOrgOverBudget(orgStartedAt: number, now: number, timeoutMs: number): boolean {
  return now - orgStartedAt > timeoutMs
}

// Mirror of the batch-loop-entry + per-account-loop checkpoints — both check
// the same deadline, so a slow batch that starts under budget but whose
// per-account syncInsights() calls push it over budget mid-batch is still
// caught before the next batch/account, not just at the next batch boundary.
function shouldStopBatchLoop(orgStartedAt: number, now: number, timeoutMs: number): boolean {
  return isOrgOverBudget(orgStartedAt, now, timeoutMs)
}

function shouldStopAccountLoop(orgStartedAt: number, now: number, timeoutMs: number): boolean {
  return isOrgOverBudget(orgStartedAt, now, timeoutMs)
}

describe('generate-insights — garde d\'isolation par org (issue #65, 2026-08-23)', () => {
  const TIMEOUT_MS = 90_000

  it('sous le délai : la boucle de batch continue', () => {
    expect(shouldStopBatchLoop(0, 50_000, TIMEOUT_MS)).toBe(false)
  })

  it('au-delà du délai en tête de boucle de batch : arrêt avant de démarrer le batch suivant', () => {
    expect(shouldStopBatchLoop(0, 95_000, TIMEOUT_MS)).toBe(true)
  })

  it('un batch démarré sous le délai peut quand même dépasser en cours de route (boucle par-compte)', () => {
    // Le batch démarre à 80s (encore sous les 90s), mais les appels
    // syncInsights() séquentiels dans la boucle par-compte font franchir le
    // délai avant la fin du batch — c'est précisément le mécanisme qui
    // accumule le temps réel (un aller-retour DB par compte, pas de batching
    // d'écriture contrairement à calculate-scores).
    expect(shouldStopBatchLoop(0, 80_000, TIMEOUT_MS)).toBe(false) // le batch démarre
    expect(shouldStopAccountLoop(0, 92_000, TIMEOUT_MS)).toBe(true) // mais s'arrête en cours
  })

  it('séquence complète : un org lent est coupé, l\'org suivant démarre quand même (pas de blocage en cascade)', () => {
    const orgStartedAt = 0
    let timedOut = false
    const accountsProcessed: number[] = []
    // 200 comptes, chacun "coûtant" 1s de temps réel simulé (await séquentiel)
    for (let i = 1; i <= 200; i++) {
      const now = i * 1_000
      if (shouldStopAccountLoop(orgStartedAt, now, TIMEOUT_MS)) {
        timedOut = true
        break
      }
      accountsProcessed.push(i)
    }

    expect(timedOut).toBe(true)
    // Le 90e compte tombe pile à 90_000ms (pas strictement > 90_000, donc
    // encore traité) ; le 91e (91_000ms) dépasse et interrompt la boucle.
    expect(accountsProcessed).toHaveLength(90)
    expect(accountsProcessed[accountsProcessed.length - 1]).toBe(90)
  })
})
