type CBState = 'closed' | 'open' | 'half-open'

export class CircuitBreaker {
  private state: CBState = 'closed'
  private failures = 0
  private lastFailureTime = 0
  private readonly failureThreshold: number
  private readonly resetTimeoutMs: number
  readonly name: string

  constructor(opts: { failureThreshold?: number; resetTimeoutMs?: number; name: string }) {
    this.failureThreshold = opts.failureThreshold ?? 5
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 60000
    this.name = opts.name
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = 'half-open'
      } else {
        throw new Error(`Circuit breaker '${this.name}' is OPEN`)
      }
    }

    try {
      const result = await fn()
      if (this.state === 'half-open') {
        this.state = 'closed'
        this.failures = 0
      }
      return result
    } catch (err) {
      this.failures++
      this.lastFailureTime = Date.now()
      if (this.failures >= this.failureThreshold) {
        this.state = 'open'
      }
      throw err
    }
  }

  getState(): CBState {
    return this.state
  }
}
