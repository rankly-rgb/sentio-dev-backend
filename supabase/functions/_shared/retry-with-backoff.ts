interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  jitter?: boolean
  retryOn?: (error: unknown) => boolean
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 500,
    maxDelayMs = 10000,
    jitter = true,
    retryOn,
  } = opts

  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt === maxRetries) break
      if (retryOn && !retryOn(err)) break
      let delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs)
      if (jitter) delay = delay * (0.5 + Math.random() * 0.5)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastError
}
