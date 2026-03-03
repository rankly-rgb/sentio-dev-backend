// ============================================================
// Resend Email Integration
// Envoi d'emails via Resend API avec timeout + retry
// Mode log-only si RESEND_API_KEY absent
// ============================================================

import { fetchWithTimeout } from './fetch-with-timeout.ts'

export interface SendEmailParams {
  to: string
  subject: string
  html: string
  from_name?: string
  reply_to?: string
}

export interface SendEmailResult {
  success: boolean
  resend_message_id?: string
  error?: string
  log_only?: boolean
}

const RESEND_API_URL = 'https://api.resend.com/emails'
const RESEND_TIMEOUT_MS = 8000

/**
 * Envoie un email via Resend API.
 * Si RESEND_API_KEY n'est pas configure, log l'email sans l'envoyer.
 */
export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const apiKey = Deno.env.get('RESEND_API_KEY')
  const fromEmail = Deno.env.get('RESEND_FROM_EMAIL') || 'notifications@sentio.app'

  if (!apiKey) {
    console.log('[resend] RESEND_API_KEY not set — log-only mode')
    console.log('[resend] Would send:', JSON.stringify({
      to: params.to,
      subject: params.subject,
      from: params.from_name || 'Sentio AI',
    }))
    return {
      success: true,
      log_only: true,
      resend_message_id: 'log-only-' + crypto.randomUUID(),
    }
  }

  try {
    const response = await fetchWithTimeout(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: (params.from_name || 'Sentio AI') + ' <' + fromEmail + '>',
        to: [params.to],
        subject: params.subject,
        html: params.html,
        reply_to: params.reply_to || undefined,
      }),
    }, RESEND_TIMEOUT_MS)

    if (!response.ok) {
      const errorText = await response.text()
      return {
        success: false,
        error: 'Resend API error: ' + response.status + ' ' + errorText,
      }
    }

    const data = await response.json()
    return {
      success: true,
      resend_message_id: data.id,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      error: 'Resend send failed: ' + message,
    }
  }
}
