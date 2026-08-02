// ============================================================
// Résolution des comptes ciblés par un playbook — partagé entre
// playbook-execute (dispatch réel) et export-playbook-csv (preview +
// export CSV, chantier A). Même règle de ciblage dans les deux cas :
// account_ids explicites, sinon segment_id -> segment_memberships,
// puis filtre eligibility_criteria — pour éviter que les deux chemins
// divergent silencieusement sur qui est "ciblé" par un playbook.
// ============================================================

import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { evaluateConditions, type AccountData, type ConditionGroup } from './playbook-engine.ts'

const ACCOUNT_SELECT_COLUMNS =
  'id, organization_id, stripe_customer_id, hubspot_company_id, display_name, health_score, churn_risk_score, expansion_score, product_usage_score, mrr_cents, arr_cents, plan_tier, seat_count, seat_limit, contract_start_date, contract_end_date, created_at'

export interface TargetablePlaybook {
  segment_id?: string | null
  eligibility_criteria?: ConditionGroup | null
}

export async function resolvePlaybookTargetAccounts(
  supabase: SupabaseClient,
  playbook: TargetablePlaybook,
  organizationId: string,
  maxAccounts: number,
  explicitAccountIds?: string[],
): Promise<AccountData[]> {
  let accountIds: string[]

  if (explicitAccountIds?.length) {
    accountIds = explicitAccountIds.slice(0, maxAccounts)
  } else if (playbook.segment_id) {
    const { data: memberships } = await supabase
      .from('segment_memberships')
      .select('account_id')
      .eq('segment_id', playbook.segment_id)
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .limit(maxAccounts)

    accountIds = (memberships ?? []).map((m: Record<string, unknown>) => m.account_id as string)
  } else {
    return []
  }

  if (accountIds.length === 0) return []

  const { data: accounts } = await supabase
    .from('accounts')
    .select(ACCOUNT_SELECT_COLUMNS)
    .eq('organization_id', organizationId)
    .in('id', accountIds)

  const rows = (accounts ?? []) as AccountData[]

  // C2.5 : une sélection manuelle explicite (account_ids) exprime déjà
  // l'intention de l'utilisateur — elle n'est jamais filtrée par
  // eligibility_criteria (sinon "Run this playbook on this account" depuis
  // une carte insight pourrait silencieusement ne rien exécuter). Seule la
  // résolution par segment_id passe par evaluateConditions, qui ne matche
  // plus rien par défaut si eligibility_criteria est vide/absent.
  if (explicitAccountIds?.length) return rows

  return rows.filter((a) => evaluateConditions(playbook.eligibility_criteria, a as unknown as Record<string, unknown>))
}
