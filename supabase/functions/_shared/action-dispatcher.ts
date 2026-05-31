// ============================================================
// Action Dispatcher — dispatch réel des actions playbook
// Remplace executeAction() (log-only) pour les actions externes
// ============================================================

import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import {
  getCompanyContacts,
  enrollInSequence,
  updateCompanyProperties,
  createTask,
  associateTaskToCompany,
} from './hubspot-client.ts'
import { writeToDLQ } from './dlq.ts'
import type { PlaybookAction, AccountData, ActionResult } from './playbook-engine.ts'

const MAX_CONTACTS_PER_COMPANY = 5

interface DispatchContext {
  playbookId: string
  executionId: string
  organizationId: string
  playbookTitle?: string
  /** Cache pré-rempli par getBatchCompanyContacts. Absent du Map = fallback individuel. */
  contactsCache?: Map<string, string[]>
  /** Clé API HubSpot résolue depuis Vault. Fallback sur env HUBSPOT_API_KEY si absent. */
  hubspotApiKey?: string
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

        // Utiliser le cache batch si disponible, sinon fallback individuel
        const contactIds = context.contactsCache?.has(account.hubspot_company_id)
          ? context.contactsCache.get(account.hubspot_company_id)!
          : await getCompanyContacts(account.hubspot_company_id, context.hubspotApiKey)

        if (contactIds.length === 0) {
          return {
            ...base,
            status: 'skipped',
            message: `No HubSpot contacts found for company ${account.hubspot_company_id}`,
          }
        }

        const toEnroll = contactIds.slice(0, MAX_CONTACTS_PER_COMPANY)
        const results = await Promise.allSettled(
          toEnroll.map((cid) => enrollInSequence(cid, sequenceId, senderId, context.hubspotApiKey)),
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

        const result = await updateCompanyProperties(account.hubspot_company_id, properties, context.hubspotApiKey)

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

      case 'hubspot_create_task': {
        if (!account.hubspot_company_id) {
          return {
            ...base,
            status: 'skipped',
            message: `Account ${account.id} has no hubspot_company_id — skipping task creation`,
          }
        }

        const rawBody = (action.config.task_body as string | undefined) ?? ''
        const priorityRaw = action.config.priority as string | undefined
        const priority = (['HIGH', 'MEDIUM', 'LOW'].includes(priorityRaw ?? '')
          ? priorityRaw
          : 'HIGH') as 'HIGH' | 'MEDIUM' | 'LOW'

        // Sujet : Zero-PII — display_name est un alias Sentio, jamais un nom de personne physique
        const displayName = account.display_name ?? account.stripe_customer_id ?? account.id
        const playbookTitle = context.playbookTitle ?? 'Playbook'
        const subject = `Sentio — ${playbookTitle} : ${displayName}`

        // Interpolation des variables dans le corps
        const mrrEuros = account.mrr_cents != null ? Math.round(account.mrr_cents / 100) : 0
        const body = rawBody
          .replace(/\{\{display_name\}\}/g, displayName)
          .replace(/\{\{health_score\}\}/g, String(account.health_score ?? 'N/A'))
          .replace(/\{\{churn_risk_score\}\}/g, String(account.churn_risk_score ?? 'N/A'))
          .replace(/\{\{mrr_cents\}\}/g, String(account.mrr_cents ?? 0))
          .replace(/\{\{mrr_euros\}\}/g, String(mrrEuros))

        const taskResult = await createTask(subject, body, priority, context.hubspotApiKey)

        if (!taskResult.success || !taskResult.taskId) {
          await writeToDLQ(supabase, {
            organization_id: context.organizationId,
            provider: 'hubspot',
            event_type: 'task_creation_failed',
            payload: {
              account_id: account.id,
              company_id: account.hubspot_company_id,
            },
            error_message: taskResult.error ?? `HTTP ${taskResult.status}`,
          })
          return {
            ...base,
            status: 'failed',
            message: `Failed to create HubSpot task: ${taskResult.error ?? `HTTP ${taskResult.status}`}`,
          }
        }

        // Association tâche → company (non-bloquante)
        const assocResult = await associateTaskToCompany(
          taskResult.taskId,
          account.hubspot_company_id,
          context.hubspotApiKey,
        )
        if (!assocResult.success) {
          console.error(JSON.stringify({
            level: 'warn',
            module: 'action-dispatcher',
            fn: 'hubspot_create_task',
            message: 'Task created but company association failed (non-blocking)',
            task_id: taskResult.taskId,
            company_id: account.hubspot_company_id,
            error: assocResult.error,
          }))
        }

        return {
          ...base,
          status: 'completed',
          message: `HubSpot task ${taskResult.taskId} created for account ${account.id}` +
            (assocResult.success ? ' (associated to company)' : ' (association failed — non-blocking)'),
        }
      }

      case 'send_email':
        // send_email n'est supporté que dans les workflow playbooks (via executeWorkflowStep)
        // Dans un playbook standard il n'y a pas de contexte CSM email — échouer explicitement
        return {
          ...base,
          status: 'failed',
          message: 'send_email is only supported in workflow playbooks, not standard playbooks',
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
