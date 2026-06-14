// ============================================================
// Action Dispatcher — dispatch réel des actions playbook
// V1 : send_email (Resend) + export_csv (déclaratif) + log-only
// V2 : réactiver HubSpot (cases commentés ci-dessous)
// ============================================================

import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { writeToDLQ } from './dlq.ts'
import type { PlaybookAction, AccountData, ActionResult } from './playbook-engine.ts'

interface DispatchContext {
  playbookId: string
  executionId: string
  organizationId: string
  playbookTitle?: string
  segmentName?: string
  /** Email de notification de l'org — requis pour l'action send_email. */
  organization_notification_email?: string
  /** Nombre de comptes ciblés — utilisé par export_csv pour le message. */
  accounts_targeted?: number
  /** V2 — HubSpot : cache contacts pré-rempli par getBatchCompanyContacts. */
  contactsCache?: Map<string, string[]>
  /** V2 — HubSpot : clé API résolue depuis Vault. */
  hubspotApiKey?: string
}

/**
 * Dispatch une action playbook vers le système externe approprié.
 * V1 :
 *   - send_email     : alerte email via Resend (organization_notification_email requis)
 *   - export_csv     : marqueur déclaratif — téléchargement géré côté frontend
 *   - log_note / flag_for_review / autres : log-only
 */
export async function dispatchAction(
  action: PlaybookAction,
  account: AccountData,
  context: DispatchContext,
  supabase: SupabaseClient,
): Promise<ActionResult> {
  const base = {
    action_type: action.type,
    order: action.order,
    executed_at: new Date().toISOString(),
  }

  try {
    switch (action.type) {
      /* V2 — réactiver quand HubSpot sera réintégré
      case 'hubspot_enroll_sequence': { ... }
      case 'hubspot_update_company': { ... }
      case 'hubspot_create_task': { ... }
      */

      case 'send_email': {
        const emailSubject = action.config.email_subject as string | undefined
        const emailBodyHtml = action.config.email_body_html as string | undefined
        const resendApiKey = Deno.env.get('RESEND_API_KEY')
        const notificationEmail = context.organization_notification_email

        if (!resendApiKey) {
          return { ...base, status: 'failed', message: 'RESEND_API_KEY not configured' }
        }
        if (!notificationEmail) {
          return { ...base, status: 'failed', message: 'No notification_email configured for this organization' }
        }
        if (!emailSubject || !emailBodyHtml) {
          return { ...base, status: 'failed', message: 'send_email requires email_subject and email_body_html in config' }
        }

        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'Sentio AI <alerts@sentioapp.io>',
            to: [notificationEmail],
            subject: emailSubject,
            html: emailBodyHtml,
          }),
        })

        if (!res.ok) {
          const errText = await res.text()
          return { ...base, status: 'failed', message: `Resend error ${res.status}: ${errText.slice(0, 200)}` }
        }

        return { ...base, status: 'completed', message: `Email sent to ${notificationEmail}` }
      }

      case 'export_csv': {
        // En V1, export_csv est déclaratif : marque l'exécution comme réussie et
        // signale au frontend qu'un export est disponible via l'endpoint CSV existant.
        // Transit PII : les emails sont résolus depuis Stripe côté frontend, jamais stockés.
        return {
          ...base,
          status: 'completed',
          message: `Export CSV disponible pour ${context.accounts_targeted ?? 0} compte(s) ciblé(s)`,
        }
      }

      default:
        // Autres types d'actions (log_note, flag_for_review, etc.) : log-only
        return {
          ...base,
          status: 'completed',
          message: `Action logged: ${action.type} for account ${account.id} ` +
            `(playbook=${context.playbookId}, execution=${context.executionId}, ` +
            `config=${JSON.stringify(action.config)})`,
        }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    await writeToDLQ(supabase, {
      organization_id: context.organizationId,
      provider: 'outbound',
      event_type: 'action_dispatch_error',
      payload: {
        account_id: account.id,
        action_type: action.type,
        config: action.config,
      },
      error_message: message,
    })

    return { ...base, status: 'failed', message }
  }
}
