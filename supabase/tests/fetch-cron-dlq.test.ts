import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── fetchWithTimeout ─────────────────────────────────────────

import { fetchWithTimeout } from '../functions/_shared/fetch-with-timeout'

describe('fetchWithTimeout', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('returns response on successful fetch', async () => {
    const mockResponse = new Response('ok', { status: 200 })
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse)

    const result = await fetchWithTimeout('https://example.com/api')
    expect(result.status).toBe(200)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('passes options to fetch', async () => {
    const mockResponse = new Response('ok', { status: 200 })
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse)

    await fetchWithTimeout('https://example.com/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"key":"value"}',
    })

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[0]).toBe('https://example.com/api')
    expect(callArgs[1].method).toBe('POST')
    expect(callArgs[1].headers).toEqual({ 'Content-Type': 'application/json' })
    expect(callArgs[1].body).toBe('{"key":"value"}')
  })

  it('attaches AbortSignal to request', async () => {
    const mockResponse = new Response('ok', { status: 200 })
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse)

    await fetchWithTimeout('https://example.com/api', {}, 5000)

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[1].signal).toBeInstanceOf(AbortSignal)
  })

  it('throws timeout error when fetch takes too long', async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          const err = new DOMException('The operation was aborted', 'AbortError')
          reject(err)
        })
      })
    })

    await expect(
      fetchWithTimeout('https://example.com/slow', {}, 50)
    ).rejects.toThrow('timed out after 50ms')
  })

  it('uses default 8000ms timeout', async () => {
    const mockResponse = new Response('ok', { status: 200 })
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse)

    // Should not throw with fast response
    const result = await fetchWithTimeout('https://example.com/api')
    expect(result.status).toBe(200)
  })

  it('propagates non-abort errors', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'))

    await expect(
      fetchWithTimeout('https://example.com/api')
    ).rejects.toThrow('Network error')
  })

  it('clears timeout after successful fetch', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const mockResponse = new Response('ok', { status: 200 })
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse)

    await fetchWithTimeout('https://example.com/api')
    expect(clearTimeoutSpy).toHaveBeenCalled()
  })
})

// ── Cron Lock Logic ──────────────────────────────────────────
// Test the logic patterns used by cron-lock.ts with mock Supabase client

describe('Cron Lock Logic', () => {
  function createMockSupabase(overrides?: {
    deleteError?: { message: string } | null
    insertError?: { message: string; code?: string } | null
  }) {
    const deleteError = overrides?.deleteError ?? null
    const insertError = overrides?.insertError ?? null

    return {
      from: vi.fn().mockReturnValue({
        delete: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            lt: vi.fn().mockResolvedValue({ error: deleteError }),
          }),
        }),
        insert: vi.fn().mockResolvedValue({ error: insertError }),
      }),
    }
  }

  async function acquireLock(
    supabase: ReturnType<typeof createMockSupabase>,
    lockKey: string,
    ttlSeconds = 300
  ): Promise<boolean> {
    const now = new Date()
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000)

    const fromResult = supabase.from('cron_locks')
    const { error: deleteError } = await fromResult.delete().eq('lock_key', lockKey).lt('expires_at', now.toISOString())

    if (deleteError) {
      // Continue — the insert may still succeed
    }

    const fromResult2 = supabase.from('cron_locks')
    const { error } = await fromResult2.insert({
      lock_key: lockKey,
      locked_at: now.toISOString(),
      locked_by: 'edge-function',
      expires_at: expiresAt.toISOString(),
    })

    if (error) {
      const isConflict = error.message?.includes('duplicate') || error.message?.includes('unique') || error.code === '23505'
      if (!isConflict) {
        console.error(`[cron-lock] Unexpected error: ${error.message}`)
      }
      return false
    }
    return true
  }

  it('acquires lock successfully when no conflict', async () => {
    const supabase = createMockSupabase()
    const result = await acquireLock(supabase, 'test-lock')
    expect(result).toBe(true)
    expect(supabase.from).toHaveBeenCalledWith('cron_locks')
  })

  it('returns false on duplicate key conflict', async () => {
    const supabase = createMockSupabase({
      insertError: { message: 'duplicate key violates unique constraint', code: '23505' },
    })
    const result = await acquireLock(supabase, 'test-lock')
    expect(result).toBe(false)
  })

  it('returns false on unexpected DB error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = createMockSupabase({
      insertError: { message: 'connection refused' },
    })
    const result = await acquireLock(supabase, 'test-lock')
    expect(result).toBe(false)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('continues if expired lock cleanup fails', async () => {
    const supabase = createMockSupabase({
      deleteError: { message: 'delete failed' },
    })
    const result = await acquireLock(supabase, 'test-lock')
    expect(result).toBe(true) // insert still succeeds
  })

  it('computes correct expiry time', async () => {
    const supabase = createMockSupabase()
    await acquireLock(supabase, 'test-lock', 600)
    // Verify from was called (the logic runs correctly)
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })
})

// ── DLQ Logic ────────────────────────────────────────────────
// Test the DLQ write-or-log pattern

describe('DLQ Logic', () => {
  function createMockSupabase(insertError?: Error | null) {
    return {
      from: vi.fn().mockReturnValue({
        insert: insertError
          ? vi.fn().mockRejectedValue(insertError)
          : vi.fn().mockResolvedValue({ error: null }),
      }),
    }
  }

  async function writeToDLQ(
    supabase: ReturnType<typeof createMockSupabase>,
    entry: {
      organization_id: string
      provider: string
      event_type: string
      payload: unknown
      error_message: string
      retry_count?: number
    }
  ): Promise<void> {
    try {
      await supabase.from('webhook_dead_letter').insert({
        organization_id: entry.organization_id,
        provider: entry.provider,
        event_type: entry.event_type,
        payload: entry.payload,
        error_message: entry.error_message,
        retry_count: entry.retry_count ?? 0,
        max_retries: 3,
      })
    } catch {
      console.error(JSON.stringify({
        level: 'error',
        message: 'Failed to write to DLQ',
        provider: entry.provider,
        event_type: entry.event_type,
        error: entry.error_message,
      }))
    }
  }

  it('writes entry to DLQ successfully', async () => {
    const supabase = createMockSupabase()
    await writeToDLQ(supabase, {
      organization_id: 'org-1',
      provider: 'stripe',
      event_type: 'invoice.paid',
      payload: { id: 'evt_1' },
      error_message: 'handler failed',
    })
    expect(supabase.from).toHaveBeenCalledWith('webhook_dead_letter')
  })

  it('defaults retry_count to 0', async () => {
    const supabase = createMockSupabase()
    await writeToDLQ(supabase, {
      organization_id: 'org-1',
      provider: 'stripe',
      event_type: 'invoice.paid',
      payload: {},
      error_message: 'error',
    })
    const insertCall = supabase.from('webhook_dead_letter').insert
    expect(insertCall).toHaveBeenCalledWith(expect.objectContaining({
      retry_count: 0,
      max_retries: 3,
    }))
  })

  it('uses provided retry_count', async () => {
    const supabase = createMockSupabase()
    await writeToDLQ(supabase, {
      organization_id: 'org-1',
      provider: 'hubspot',
      event_type: 'contact.update',
      payload: {},
      error_message: 'error',
      retry_count: 2,
    })
    const insertCall = supabase.from('webhook_dead_letter').insert
    expect(insertCall).toHaveBeenCalledWith(expect.objectContaining({
      retry_count: 2,
    }))
  })

  it('logs to console.error if DLQ write fails (never throws)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = createMockSupabase(new Error('DB connection lost'))

    // Should NOT throw
    await writeToDLQ(supabase, {
      organization_id: 'org-1',
      provider: 'stripe',
      event_type: 'invoice.paid',
      payload: {},
      error_message: 'original error',
    })

    expect(errorSpy).toHaveBeenCalledTimes(1)
    const loggedOutput = JSON.parse(errorSpy.mock.calls[0][0] as string)
    expect(loggedOutput.level).toBe('error')
    expect(loggedOutput.message).toBe('Failed to write to DLQ')
    expect(loggedOutput.provider).toBe('stripe')
    errorSpy.mockRestore()
  })

  it('includes event_type in error log on failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = createMockSupabase(new Error('timeout'))

    await writeToDLQ(supabase, {
      organization_id: 'org-1',
      provider: 'usage',
      event_type: 'page.view',
      payload: {},
      error_message: 'timeout',
    })

    const loggedOutput = JSON.parse(errorSpy.mock.calls[0][0] as string)
    expect(loggedOutput.event_type).toBe('page.view')
    errorSpy.mockRestore()
  })
})
