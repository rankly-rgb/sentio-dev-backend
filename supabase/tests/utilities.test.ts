import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Circuit Breaker ───────────────────────────────────────────

// Import as .ts — vitest handles the extension
import { CircuitBreaker } from '../functions/_shared/circuit-breaker'

describe('CircuitBreaker', () => {
  it('starts in closed state', () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 })
    expect(cb.getState()).toBe('closed')
  })

  it('stays closed on successful calls', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 })
    const result = await cb.execute(() => Promise.resolve('ok'))
    expect(result).toBe('ok')
    expect(cb.getState()).toBe('closed')
  })

  it('opens after reaching failure threshold', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 })

    for (let i = 0; i < 3; i++) {
      try {
        await cb.execute(() => Promise.reject(new Error('fail')))
      } catch { /* expected */ }
    }

    expect(cb.getState()).toBe('open')
  })

  it('throws immediately when open', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, resetTimeoutMs: 60000 })

    try {
      await cb.execute(() => Promise.reject(new Error('fail')))
    } catch { /* expected */ }

    expect(cb.getState()).toBe('open')

    await expect(
      cb.execute(() => Promise.resolve('ok'))
    ).rejects.toThrow("Circuit breaker 'test' is OPEN")
  })

  it('transitions to half-open after reset timeout', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, resetTimeoutMs: 10 })

    try {
      await cb.execute(() => Promise.reject(new Error('fail')))
    } catch { /* expected */ }

    expect(cb.getState()).toBe('open')

    // Wait for reset timeout
    await new Promise(r => setTimeout(r, 20))

    // Should transition to half-open and then closed on success
    const result = await cb.execute(() => Promise.resolve('recovered'))
    expect(result).toBe('recovered')
    expect(cb.getState()).toBe('closed')
  })

  it('returns to open from half-open on failure', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, resetTimeoutMs: 10 })

    try {
      await cb.execute(() => Promise.reject(new Error('fail')))
    } catch { /* expected */ }

    await new Promise(r => setTimeout(r, 20))

    try {
      await cb.execute(() => Promise.reject(new Error('fail again')))
    } catch { /* expected */ }

    expect(cb.getState()).toBe('open')
  })
})

// ── Retry with Backoff ────────────────────────────────────────

import { retryWithBackoff } from '../functions/_shared/retry-with-backoff'

describe('retryWithBackoff', () => {
  it('succeeds on first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 1 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries and succeeds on second attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('ok')

    const result = await retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 1, jitter: false })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('throws after exhausting retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('permanent'))

    await expect(
      retryWithBackoff(fn, { maxRetries: 2, baseDelayMs: 1, jitter: false })
    ).rejects.toThrow('permanent')

    expect(fn).toHaveBeenCalledTimes(3) // initial + 2 retries
  })

  it('respects retryOn predicate', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('not retryable'))

    await expect(
      retryWithBackoff(fn, {
        maxRetries: 3,
        baseDelayMs: 1,
        retryOn: () => false,
      })
    ).rejects.toThrow('not retryable')

    expect(fn).toHaveBeenCalledTimes(1) // no retries
  })

  it('uses exponential backoff timing', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockResolvedValueOnce('ok')

    const start = Date.now()
    await retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 50, jitter: false })
    const elapsed = Date.now() - start

    // First retry: 50ms, second: 100ms = 150ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(100) // some tolerance
  })
})

// ── Structured Logger ─────────────────────────────────────────

import { createLogger } from '../functions/_shared/structured-logger'

describe('createLogger', () => {
  it('outputs JSON with required fields', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const logger = createLogger({
      correlation_id: 'test-123',
      organization_id: 'org-456',
      function_name: 'test-fn',
      provider: 'stripe',
    })

    logger.info('test message', { extra_field: 42 })

    expect(consoleSpy).toHaveBeenCalledTimes(1)
    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string)

    expect(output.level).toBe('info')
    expect(output.correlation_id).toBe('test-123')
    expect(output.organization_id).toBe('org-456')
    expect(output.function_name).toBe('test-fn')
    expect(output.provider).toBe('stripe')
    expect(output.message).toBe('test message')
    expect(output.extra_field).toBe(42)
    expect(output.timestamp).toBeDefined()

    consoleSpy.mockRestore()
  })

  it('uses console.error for error level', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const logger = createLogger({
      correlation_id: 'test-123',
      function_name: 'test-fn',
    })

    logger.error('something broke')

    expect(consoleSpy).toHaveBeenCalledTimes(1)
    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string)
    expect(output.level).toBe('error')

    consoleSpy.mockRestore()
  })

  it('uses console.warn for warn level', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const logger = createLogger({
      correlation_id: 'test-123',
      function_name: 'test-fn',
    })

    logger.warn('heads up')

    expect(consoleSpy).toHaveBeenCalledTimes(1)
    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string)
    expect(output.level).toBe('warn')

    consoleSpy.mockRestore()
  })

  it('handles null organization_id and provider', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const logger = createLogger({
      correlation_id: 'test-123',
      function_name: 'test-fn',
    })

    logger.info('no org')

    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string)
    expect(output.organization_id).toBeNull()
    expect(output.provider).toBeNull()

    consoleSpy.mockRestore()
  })
})
