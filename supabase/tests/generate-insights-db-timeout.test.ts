import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mirror of withTimeout (generate-insights/index.ts, 2026-08-24) — that file
// imports jsr: specifiers Vitest/Node cannot resolve, same convention as
// generate-insights-timeout-guard.test.ts.
//
// Added after org f2bf45aa (422 accounts) needed self-monitor's external
// 15-minute sweep to auto-fail despite ORG_INSIGHTS_TIMEOUT_MS (90s,
// generate-insights-timeout-guard.test.ts) already being live — the
// cooperative check can only stop the loop BETWEEN awaits, never preempt a
// single stuck one. Every Supabase call in prefetchInsightData/syncInsights/
// the accounts query is now wrapped so one abnormally slow DB round-trip
// surfaces as a normal error instead of blocking the whole invocation.
const DB_QUERY_TIMEOUT_MS = 10_000

function withTimeout<T>(promise: PromiseLike<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${DB_QUERY_TIMEOUT_MS}ms`))
    }, DB_QUERY_TIMEOUT_MS)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

// Minimal thenable — mirrors Supabase's PostgrestBuilder (thenable, not a
// real Promise instance) rather than testing only against native Promises.
function thenable<T>(resolver: (resolve: (v: T) => void, reject: (e: unknown) => void) => void): PromiseLike<T> {
  return { then: (onFulfilled, onRejected) => new Promise((res, rej) => resolver(
    (v) => res((onFulfilled ? onFulfilled(v) : v) as never),
    (e) => (onRejected ? rej(onRejected(e)) : rej(e)),
  )) }
}

describe('generate-insights — withTimeout (2026-08-24)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves with the value when the promise settles before the deadline', async () => {
    const fast = Promise.resolve({ data: [{ id: 'a' }], error: null })
    const result = await withTimeout(fast, 'fast query')
    expect(result).toEqual({ data: [{ id: 'a' }], error: null })
  })

  it('propagates the original rejection when the promise rejects before the deadline', async () => {
    const failing = Promise.reject(new Error('connection reset'))
    await expect(withTimeout(failing, 'failing query')).rejects.toThrow('connection reset')
  })

  it('rejects with a labeled timeout error once DB_QUERY_TIMEOUT_MS elapses without settling', async () => {
    const neverSettles = new Promise(() => {
      // deliberately never resolves/rejects — simulates the org f2bf45aa hang
    })
    const pending = withTimeout(neverSettles, 'syncInsights: update (account acct-1, payment_risk)')
    const assertion = expect(pending).rejects.toThrow(
      'syncInsights: update (account acct-1, payment_risk) timed out after 10000ms',
    )
    await vi.advanceTimersByTimeAsync(DB_QUERY_TIMEOUT_MS)
    await assertion
  })

  it('does not fire the timeout after an early resolution (timer is cleared)', async () => {
    const fast = Promise.resolve('ok')
    await withTimeout(fast, 'fast query')
    // If the timer weren't cleared, this would produce an unhandled
    // rejection once fake timers advance past the deadline.
    await vi.advanceTimersByTimeAsync(DB_QUERY_TIMEOUT_MS + 1)
  })

  it('works with a thenable that is not a native Promise instance (mirrors Supabase PostgrestBuilder)', async () => {
    const builder = thenable<{ data: unknown[]; error: null }>((resolve) => {
      resolve({ data: [], error: null })
    })
    const result = await withTimeout(builder, 'thenable query')
    expect(result).toEqual({ data: [], error: null })
  })

  it('times out a thenable that never settles, same as a native Promise', async () => {
    const builder = thenable<never>(() => {
      // never calls resolve/reject
    })
    const pending = withTimeout(builder, 'thenable query')
    const assertion = expect(pending).rejects.toThrow('thenable query timed out after 10000ms')
    await vi.advanceTimersByTimeAsync(DB_QUERY_TIMEOUT_MS)
    await assertion
  })
})
