// ============================================================
// CSV export utilities — partagé entre export-csv et
// export-playbook-csv. Résolution email en transit depuis Stripe
// (Zero-PII : jamais persisté), échappement CSV, masquage d'ID.
// ============================================================

import { fetchWithTimeout } from './fetch-with-timeout.ts'

const STRIPE_BATCH_SIZE = 10
const STRIPE_BATCH_DELAY_MS = 100

export interface ContactInfo {
  email: string
  name: string
}

export function maskCustomerId(id: string): string {
  return `cus_***${id.slice(-3)}`
}

export function escapeField(val: unknown): string {
  const str = String(val ?? '')
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

// Résolution emails Stripe en transit — jamais persistés (Zero-PII).
export async function resolveEmails(
  stripeApiKey: string,
  customerIds: string[],
  fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
    fetchWithTimeout(url, init, 5000),
): Promise<Map<string, ContactInfo>> {
  const results = new Map<string, ContactInfo>()

  for (let i = 0; i < customerIds.length; i += STRIPE_BATCH_SIZE) {
    const batch = customerIds.slice(i, i + STRIPE_BATCH_SIZE)
    await Promise.all(
      batch.map(async (customerId) => {
        try {
          const resp = await fetcher(
            `https://api.stripe.com/v1/customers/${customerId}`,
            { headers: { Authorization: `Bearer ${stripeApiKey}` } },
          )
          if (resp.ok) {
            const customer = await resp.json()
            results.set(customerId, {
              email: typeof customer.email === 'string' ? customer.email : '',
              name: typeof customer.name === 'string' ? customer.name : '',
            })
          } else {
            results.set(customerId, { email: '', name: '' })
          }
        } catch {
          results.set(customerId, { email: '', name: '' })
        }
      }),
    )
    if (i + STRIPE_BATCH_SIZE < customerIds.length) {
      await new Promise((r) => setTimeout(r, STRIPE_BATCH_DELAY_MS))
    }
  }
  return results
}
