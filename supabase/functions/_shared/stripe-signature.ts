// ============================================================
// Vérification de signature webhook Stripe (HMAC-SHA256) — partagée
// entre stripe-webhook (compte client connecté) et
// stripe-billing-webhook (compte Stripe de Sentio, chantier C).
// Chaque appelant utilise son propre secret (STRIPE_WEBHOOK_SECRET vs
// STRIPE_BILLING_WEBHOOK_SECRET) — ce sont deux comptes Stripe
// distincts avec des signing secrets distincts, jamais interchangeables.
// ============================================================

export async function verifyStripeSignature(
  rawBody: Uint8Array,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) return false

  const parts: Record<string, string> = {}
  for (const item of signatureHeader.split(',')) {
    const [k, v] = item.split('=')
    if (k && v) parts[k] = v
  }

  const timestamp = parts['t']
  const v1 = parts['v1']
  if (!timestamp || !v1) return false

  // Reject webhooks older than 5 minutes (replay attack prevention)
  const webhookAge = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10))
  if (webhookAge > 300) return false

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const payload = encoder.encode(`${timestamp}.`)
  const combined = new Uint8Array(payload.length + rawBody.length)
  combined.set(payload, 0)
  combined.set(rawBody, payload.length)

  const sig = await crypto.subtle.sign('HMAC', key, combined)
  const computed = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  return computed === v1
}
