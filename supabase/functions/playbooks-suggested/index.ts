// ============================================================
// Edge Function : playbooks-suggested
// Suggestion déterministe du playbook le plus pertinent à activer,
// basée sur l'état réel du portefeuille.
//
// RÈGLES DE PRIORITÉ (ordre décroissant) :
//   1. en_danger_critique → churn_prevention
//   2. impayes            → payment_recovery
//   3. en_churn           → winback
//   4. champions          → expansion (Scoring V2 : champions implique déjà
//                            des expansion_signals actifs, voir scoring.ts)
//   5. a_risque_leger     → health_monitoring (si >= 3 comptes)
//   6. renewal_alert insights actifs → renewal
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// GET /playbooks-suggested
//   Response 200 :
//     {
//       data: {
//         suggested_playbook_id: string | null,  // ID du playbook existant si trouvé
//         template_category: string,             // catégorie suggérée
//         title: string,                         // titre du playbook (existant ou suggéré)
//         reason: string,                        // phrase courte expliquant la suggestion
//         accounts_targeted: number,             // nb de comptes qui seraient ciblés
//         already_active: boolean,               // un playbook du même type est déjà actif
//         segment_type: string | null            // segment source de la suggestion
//       } | null                                 // null si aucune suggestion pertinente
//     }
//
// Auth : JWT utilisateur vérifié dans le code (ES256 via verifyUserAuth)
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { withSentry } from '../_shared/sentry.ts'

interface SuggestionRule {
  segment_type: string | null
  template_category: string
  min_accounts: number
  reason: (count: number) => string
  suggested_title: string
}

const SUGGESTION_RULES: SuggestionRule[] = [
  {
    segment_type: 'en_danger_critique',
    template_category: 'churn_prevention',
    min_accounts: 1,
    reason: (n) => `${n} account(s) in critical danger identified in your portfolio.`,
    suggested_title: 'Churn Prevention Playbook',
  },
  {
    segment_type: 'impayes',
    template_category: 'payment_recovery',
    min_accounts: 1,
    reason: (n) => `${n} account(s) with outstanding payments pending resolution.`,
    suggested_title: 'Payment Recovery Playbook',
  },
  {
    segment_type: 'en_churn',
    template_category: 'winback',
    min_accounts: 1,
    reason: (n) => `${n} churned account(s) (MRR = 0) — reactivation attempt possible.`,
    suggested_title: 'Winback Playbook',
  },
  {
    // Scoring Engine V2 (2026-07-25) : 'en_expansion' n'est plus assigné par
    // calculate-scores (fusionné dans 'champions', qui exige désormais des
    // expansion_signals actifs — voir _shared/scoring.ts determineSegmentTypesV3).
    // Repointé sur 'champions' pour continuer à alimenter cette suggestion.
    segment_type: 'champions',
    template_category: 'expansion',
    min_accounts: 1,
    reason: (n) => `${n} account(s) with high expansion potential identified.`,
    suggested_title: 'Expansion Playbook',
  },
  {
    segment_type: 'a_risque_leger',
    template_category: 'health_monitoring',
    min_accounts: 3,
    reason: (n) => `${n} accounts show mild risk signals — proactive follow-up recommended.`,
    suggested_title: 'Health Monitoring Playbook',
  },
]

Deno.serve(withSentry('playbooks-suggested', async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  let auth
  try {
    auth = await verifyUserAuth(req)
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.message, err.status)
    return errorResponse('Authentication failed', 401)
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'playbooks-suggested', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  if (req.method !== 'GET') return errorResponse('Method not allowed', 405)

  const orgId = auth.organizationId

  // 1. Charger les segments (comptage live via segment_memberships, pas le cache
  //    dénormalisé account_segments.account_count — voir chantier 5.10, peut dériver
  //    du comptage réel selon le chemin de mise à jour des memberships)
  const { data: segments, error: segErr } = await supabase
    .from('account_segments')
    .select('id, segment_type')
    .eq('organization_id', orgId)
    .in('segment_type', SUGGESTION_RULES.map((r) => r.segment_type).filter(Boolean))

  if (segErr) {
    console.error(JSON.stringify({ level: 'error', function_name: 'playbooks-suggested', message: segErr.message }))
    return errorResponse('Failed to fetch segments', 500)
  }

  const segmentIds = (segments ?? []).map((s: { id: string }) => s.id)
  const liveCountBySegmentId = new Map<string, number>()

  if (segmentIds.length > 0) {
    const { data: memberships, error: memErr } = await supabase
      .from('segment_memberships')
      .select('segment_id')
      .in('segment_id', segmentIds)
      .eq('status', 'active')
      .limit(10000)

    if (memErr) {
      console.error(JSON.stringify({ level: 'error', function_name: 'playbooks-suggested', message: memErr.message }))
      return errorResponse('Failed to fetch segment memberships', 500)
    }

    for (const m of (memberships ?? [])) {
      liveCountBySegmentId.set(m.segment_id, (liveCountBySegmentId.get(m.segment_id) ?? 0) + 1)
    }
  }

  const segmentByType = new Map(
    (segments ?? []).map((s: { segment_type: string; id: string }) =>
      [s.segment_type, { ...s, account_count: liveCountBySegmentId.get(s.id) ?? 0 }]
    ),
  )

  // 2. Charger les playbooks actifs/brouillon pour détecter doublons
  const { data: existingPlaybooks, error: pbErr } = await supabase
    .from('playbooks')
    .select('id, title, template_category, status')
    .eq('organization_id', orgId)
    .in('status', ['active', 'draft'])
    .not('template_category', 'is', null)
    .limit(200)

  if (pbErr) {
    console.error(JSON.stringify({ level: 'error', function_name: 'playbooks-suggested', message: pbErr.message }))
    return errorResponse('Failed to fetch playbooks', 500)
  }

  const activeByCategory = new Map<string, { id: string; title: string; status: string }>()
  for (const pb of (existingPlaybooks ?? [])) {
    if (pb.template_category && !activeByCategory.has(pb.template_category)) {
      activeByCategory.set(pb.template_category, pb)
    }
  }

  // 3. Évaluer les règles dans l'ordre de priorité
  for (const rule of SUGGESTION_RULES) {
    const segment = rule.segment_type ? segmentByType.get(rule.segment_type) : null
    const accountCount = segment?.account_count ?? 0

    if (accountCount < rule.min_accounts) continue

    const existing = rule.template_category ? activeByCategory.get(rule.template_category) : undefined
    const alreadyActive = existing?.status === 'active'

    return jsonResponse({
      data: {
        suggested_playbook_id: existing?.id ?? null,
        template_category: rule.template_category,
        title: existing?.title ?? rule.suggested_title,
        reason: rule.reason(accountCount),
        accounts_targeted: accountCount,
        already_active: alreadyActive,
        segment_type: rule.segment_type,
      },
    })
  }

  // 4. Fallback : renewal_alert insights actifs
  const { count: renewalCount } = await supabase
    .from('ai_insights')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .eq('insight_type', 'renewal_alert')
    .eq('status', 'active')

  if ((renewalCount ?? 0) > 0) {
    const existing = activeByCategory.get('renewal')
    const alreadyActive = existing?.status === 'active'

    return jsonResponse({
      data: {
        suggested_playbook_id: existing?.id ?? null,
        template_category: 'renewal',
        title: existing?.title ?? 'Renewal Management Playbook',
        reason: `${renewalCount ?? 0} active renewal alert(s) in your portfolio.`,
        accounts_targeted: renewalCount ?? 0,
        already_active: alreadyActive,
        segment_type: null,
      },
    })
  }

  // Aucune suggestion pertinente
  return jsonResponse({ data: null })
}))
