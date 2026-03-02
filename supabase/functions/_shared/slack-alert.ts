import { fetchWithTimeout } from './fetch-with-timeout.ts'

export async function alertSlack(
  message: string,
  opts?: { level?: 'info' | 'warning' | 'critical' }
): Promise<void> {
  const url = Deno.env.get('SLACK_WEBHOOK_URL')
  if (!url) return

  const level = opts?.level ?? 'info'
  const prefix =
    level === 'critical' ? '[CRITICAL]' : level === 'warning' ? '[WARNING]' : '[INFO]'

  try {
    await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `${prefix} [Sentio] ${message}` }),
      },
      5000
    )
  } catch {
    // Fire-and-forget: alerting failure must never crash the caller
  }
}
