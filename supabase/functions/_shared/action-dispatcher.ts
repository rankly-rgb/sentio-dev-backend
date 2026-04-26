// ============================================================
// Action Dispatcher — dispatch réel des actions playbook
// Remplace executeAction() (log-only) pour les actions externes
// ============================================================

import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import {
  getCompanyContacts,
  enrollInSequence,
  updateCompanyProperties,
} from './hubspot-client.ts'
import { writeToDLQ } from './dlq.ts'
import type { PlaybookAction, AccountData, ActionResult } from './playbook-engine.ts'

const MAX_CONTACTS_PER_COMPANY = 5

interface DispatchContext {
  playbookId: string
  executionId: string
  organizationId: string
}

/**
 * Dispatch une action playbook vers le système externe approprié.
 * - hubspot_enroll_sequence : enrôle les contacts HubSpot de la company dans une séquence
 * - hubspot_update_company  : met à jour des propriétés HubSpot de la company
 * - autres types            : log-only (V1, pas de dispatch externe)
 *
 * Écrit en DLQ sur échec non-retry-able.
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
      case 'hubspot_enroll_sequence': {
        const sequenceId = action.config.sequence_id as string | undefined
        const senderId = action.config.sender_id as string | undefined

        if (!sequenceId || !senderId) {
          return {
            ...base,
            status: 'failed',
            message: 'hubspot_enroll_sequence requires sequence_id and sender_id in config',
          }
        }

        if (!account.hubspot_company_id) {
          return {
            ...base,
            status: 'skipped',
            message: `Account ${account.id} has no hubspot_company_id — skipping enrollment`,
          }
        }

        const contactIds = await getCompanyContacts(account.hubspot_company_id)
        if (contactIds.length === 0) {
          return {
            ...base,
            status: 'skipped',
            message: `No HubSpot contacts found for company ${account.hubspot_company_id}`,
          }
        }

        const toEnroll = contactIds.slice(0, MAX_CONTACTS_PER_COMPANY)
        const results = await Promise.allSettled(
          toEnroll.map((cid) => enrollInSequence(cid, sequenceId, senderId)),
        )

        const failures = results.filter(
          (r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success),
        )
        const enrolledCount = toEnroll.length - failures.length

        if (failures.length > 0) {
          const firstErr = failures[0].status === 'rejected'
            ? String(failures[0].reason)
            : (failures[0].value as ActionResult & { error?: string }).error ?? 'unknown'

          await writeToDLQ(supabase, {
            organization_id: context.organizationId,
            provider: 'hubspot',
            event_type: 'sequence_enrollment_failed',
            payload: {
              account_id: account.id,
              company_id: account.hubspot_company_id,
              sequence_id: sequenceId,
              contact_ids: toEnroll,
            },
            error_message: `${failures.length}/${toEnroll.length} contacts failed — ${firstErr}`,
          })
        }

        return {
          ...base,
          status: enrolledCount > 0 ? 'completed' : 'failed',
          message: `Enrolled ${enrolledCount}/${toEnroll.length} contacts in sequence ${sequenceId}`,
        }
      }

      case 'hubspot_update_company': {
        const properties = action.config.properties as Record<string, unknown> | undefined

        if (!properties || Object.keys(properties).length === 0) {
          return {
            ...base,
            status: 'failed',
            message: 'hubspot_update_company requires a non-empty properties object in config',
          }
        }

        if (!account.hubspot_company_id) {
          return {
            ...base,
            status: 'skipped',
            message: `Account ${account.id} has no hubspot_company_id — skipping update`,
          }
        }

        const result = await updateCompanyProperties(account.hubspot_company_id, properties)

        if (!result.success) {
          await writeToDLQ(supabase, {
            organization_id: context.organizationId,
            provider: 'hubspot',
            event_type: 'company_update_failed',
            payload: {
              account_id: account.id,
              company_id: account.hubspot_company_id,
              properties,
            },
            error_message: result.error ?? `HTTP ${result.status}`,
          })
        }

        return {
          ...base,
          status: result.success ? 'completed' : 'failed',
          message: result.success
            ? `Updated company ${account.hubspot_company_id} properties`
            : `Failed to update company: ${result.error ?? `HTTP ${result.status}`}`,
        }
      }

      default:
        // Autres types d'actions (V1 : log-only, pas de dispatch externe)
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
      provider: 'hubspot',
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
