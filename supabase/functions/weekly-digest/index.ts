// ============================================================
// Edge Function : weekly-digest
// Triggered every Monday at 07:00 UTC (08:00 Paris)
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// POST /weekly-digest
//   Auth : service_role Bearer (cron) ou appel manuel
//   Body : {} (vide)
//   Response 200 :
//     {
//       sent: number,
//       skipped: number,
//       errors: number
//     }
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, jsonResponse, errorResponse } from '../_shared/supabase-client.ts'
import { sendEmail } from '../_shared/resend.ts'

const APP_URL = Deno.env.get('NEXT_PUBLIC_APP_URL') || 'https://app.sentioapp.io'

export interface DigestAccount {
  id: string
  stripe_customer_id: string
  display_name: string | null
  mrr_cents: number
  churn_risk_score: number | null
  health_score: number | null
  expansion_score: number | null
}

export interface WeeklyStats {
  totalMrrCents: number
  prevWeekMrrCents: number
  criticalCount: number
  prevWeekCriticalCount: number
  topChurnRisks: DigestAccount[]
  topExpansion: DigestAccount[]
}

// ── Helpers exportés pour les tests ──────────────────────────

export function formatMrr(cents: number): string {
  return Math.round(cents / 100).toLocaleString('fr-FR') + '€'
}

export function formatMrrVariation(current: number, previous: number): string {
  if (previous === 0) return ''
  const pct = Math.round(((current - previous) / previous) * 100)
  if (pct > 0) return ` (+${pct}%)`
  if (pct < 0) return ` (${pct}%)`
  return ' (stable)'
}

export function formatCountVariation(current: number, previous: number): string {
  const delta = current - previous
  if (delta > 0) return ` (+${delta} vs semaine précédente)`
  if (delta < 0) return ` (${delta} vs semaine précédente)`
  return ' (stable)'
}

export function maskCustomerId(stripeCustomerId: string): string {
  return 'cus_***' + stripeCustomerId.slice(-3)
}

function formatAccountLabel(account: DigestAccount): string {
  return account.display_name || maskCustomerId(account.stripe_customer_id)
}

function accountRow(account: DigestAccount, scoreField: 'churn_risk_score' | 'expansion_score'): string {
  const label = formatAccountLabel(account)
  const mrr = Math.round(account.mrr_cents / 100)
  const score = account[scoreField] ?? 0
  const scoreLabel = scoreField === 'churn_risk_score' ? `${score}/100` : `${score}/100`
  const scoreColor = scoreField === 'churn_risk_score' ? '#dc2626' : '#16a34a'
  return `
    <tr>
      <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0">${label}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;text-align:right">${mrr}€</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;text-align:center;color:${scoreColor};font-weight:600">${scoreLabel}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0">
        <a href="${APP_URL}/dashboard/accounts/${account.id}" style="color:#3b82f6;text-decoration:none">Voir →</a>
      </td>
    </tr>`
}

export function getWeekRange(): { monday: Date; sunday: Date; label: string } {
  const today = new Date()
  const day = today.getUTCDay() // 0=Sun, 1=Mon...
  const diffToLastMonday = day === 0 ? 6 : day - 1
  const monday = new Date(today)
  monday.setUTCDate(today.getUTCDate() - diffToLastMonday - 7)
  monday.setUTCHours(0, 0, 0, 0)
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)

  const fmt = (d: Date) =>
    d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'UTC' })
  return { monday, sunday, label: `${fmt(monday)} au ${fmt(sunday)}` }
}

export function buildWeeklyDigestEmail(stats: WeeklyStats, weekLabel: string): string {
  const mrrVar = formatMrrVariation(stats.totalMrrCents, stats.prevWeekMrrCents)
  const criticalVar = formatCountVariation(stats.criticalCount, stats.prevWeekCriticalCount)

  const churnRows = stats.topChurnRisks.length > 0
    ? stats.topChurnRisks.map(a => accountRow(a, 'churn_risk_score')).join('')
    : '<tr><td colspan="4" style="padding:16px 8px;text-align:center;color:#94a3b8">Aucun compte à risque cette semaine 🎉</td></tr>'

  const expansionRows = stats.topExpansion.length > 0
    ? stats.topExpansion.map(a => accountRow(a, 'expansion_score')).join('')
    : '<tr><td colspan="4" style="padding:16px 8px;text-align:center;color:#94a3b8">Aucune opportunité détectée</td></tr>'

  const tableHeader = (cols: string[]) => `
    <thead>
      <tr style="background:#f1f5f9">
        ${cols.map(c => `<th style="padding:10px 8px;text-align:left;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em">${c}</th>`).join('')}
      </tr>
    </thead>`

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><title>Bilan rétention — Sentio AI</title></head>
<body style="font-family:sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#1a1a1a;background:#f8fafc">
  <div style="background:#fff;border-radius:8px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.08)">
    <div style="display:flex;align-items:center;margin-bottom:8px">
      <span style="font-size:28px;margin-right:12px">📊</span>
      <h1 style="margin:0;color:#0f172a;font-size:22px">Bilan rétention</h1>
    </div>
    <p style="color:#64748b;margin-top:4px;margin-bottom:28px">Semaine du ${weekLabel}</p>

    <div style="background:#f8fafc;border-radius:6px;padding:20px;margin-bottom:28px">
      <h2 style="margin:0 0 16px;color:#0f172a;font-size:16px">Vue d'ensemble</h2>
      <ul style="margin:0;padding:0 0 0 20px;line-height:2">
        <li><strong>MRR total :</strong> ${formatMrr(stats.totalMrrCents)}${mrrVar}</li>
        <li><strong>Comptes critiques :</strong> ${stats.criticalCount}${criticalVar}</li>
      </ul>
    </div>

    <h2 style="color:#0f172a;font-size:16px;margin-bottom:12px">🚨 Comptes prioritaires cette semaine</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:28px">
      ${tableHeader(['Compte', 'MRR', 'Risque churn', 'Action'])}
      <tbody>${churnRows}</tbody>
    </table>

    <h2 style="color:#0f172a;font-size:16px;margin-bottom:12px">📈 Opportunités d'expansion</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:32px">
      ${tableHeader(['Compte', 'MRR', 'Score expansion', 'Action'])}
      <tbody>${expansionRows}</tbody>
    </table>

    <div style="text-align:center">
      <a href="${APP_URL}/dashboard"
         style="background:#0f172a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;display:inline-block">
        Voir le dashboard complet →
      </a>
    </div>

    <hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0">
    <p style="color:#94a3b8;font-size:12px;text-align:center;margin:0">
      Sentio AI — Digest hebdomadaire automatique.<br>
      Pour modifier la fréquence, rendez-vous dans Paramètres.
    </p>
  </div>
</body>
</html>`
}

// ── Handler principal ─────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'weekly-digest', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const { monday: _monday } = getWeekRange()
  const prevWeekDate = new Date(_monday)
  prevWeekDate.setUTCDate(prevWeekDate.getUTCDate() - 7)
  const prevWeekDateStr = prevWeekDate.toISOString().split('T')[0]

  const { weekLabel } = { weekLabel: getWeekRange().label }

  // Orgs avec digest hebdomadaire activé et email de notification configuré
  const { data: orgs, error: orgError } = await supabase
    .from('organizations')
    .select('id, notification_email, weekly_digest_enabled')
    .eq('weekly_digest_enabled', true)
    .not('notification_email', 'is', null)

  if (orgError) {
    console.error(JSON.stringify({ level: 'error', function_name: 'weekly-digest', message: orgError.message }))
    return errorResponse('Failed to fetch organizations', 500)
  }

  const results = { sent: 0, skipped: 0, errors: 0 }

  for (const org of (orgs ?? [])) {
    if (!org.notification_email || !org.id) {
      results.skipped++
      continue
    }

    const orgId = org.id

    try {
      // Top 5 risques churn + top 5 expansion + stats courantes (3 queries parallèles)
      const [churnRes, expansionRes, statsRes, prevStatsRes] = await Promise.all([
        supabase
          .from('accounts')
          .select('id, stripe_customer_id, display_name, mrr_cents, churn_risk_score, health_score, expansion_score')
          .eq('organization_id', orgId)
          .gt('mrr_cents', 0)
          .not('churn_risk_score', 'is', null)
          .order('churn_risk_score', { ascending: false })
          .limit(5),

        supabase
          .from('accounts')
          .select('id, stripe_customer_id, display_name, mrr_cents, churn_risk_score, health_score, expansion_score')
          .eq('organization_id', orgId)
          .gt('mrr_cents', 0)
          .not('expansion_score', 'is', null)
          .order('expansion_score', { ascending: false })
          .limit(5),

        // MRR total + count critiques actuels
        supabase
          .from('accounts')
          .select('mrr_cents, churn_risk_score')
          .eq('organization_id', orgId)
          .gt('mrr_cents', 0),

        // MRR + critiques semaine précédente depuis score_history
        supabase
          .from('score_history')
          .select('mrr_cents, churn_risk_score')
          .eq('organization_id', orgId)
          .eq('snapshot_date', prevWeekDateStr),
      ])

      if (churnRes.error || expansionRes.error || statsRes.error) {
        console.error(JSON.stringify({
          level: 'error',
          function_name: 'weekly-digest',
          org_id: orgId,
          message: (churnRes.error || expansionRes.error || statsRes.error)?.message,
        }))
        results.errors++
        continue
      }

      const accounts = statsRes.data ?? []
      const prevAccounts = prevStatsRes.data ?? []

      const totalMrrCents = accounts.reduce((sum, a) => sum + (a.mrr_cents ?? 0), 0)
      const criticalCount = accounts.filter(a => (a.churn_risk_score ?? 0) >= 70).length
      const prevWeekMrrCents = prevAccounts.reduce((sum, a) => sum + (a.mrr_cents ?? 0), 0)
      const prevWeekCriticalCount = prevAccounts.filter(a => (a.churn_risk_score ?? 0) >= 70).length

      const stats: WeeklyStats = {
        totalMrrCents,
        prevWeekMrrCents,
        criticalCount,
        prevWeekCriticalCount,
        topChurnRisks: (churnRes.data ?? []) as DigestAccount[],
        topExpansion: (expansionRes.data ?? []) as DigestAccount[],
      }

      const emailResult = await sendEmail({
        to: org.notification_email,
        subject: `📊 Votre bilan rétention — semaine du ${weekLabel}`,
        html: buildWeeklyDigestEmail(stats, weekLabel),
        from_name: 'Sentio AI',
      })

      if (emailResult.success) {
        results.sent++
        console.log(JSON.stringify({
          level: 'info',
          function_name: 'weekly-digest',
          org_id: org.id,
          log_only: emailResult.log_only ?? false,
        }))
      } else {
        results.errors++
        console.error(JSON.stringify({
          level: 'error',
          function_name: 'weekly-digest',
          org_id: org.id,
          message: emailResult.error,
        }))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(JSON.stringify({
        level: 'error',
        function_name: 'weekly-digest',
        org_id: org.id,
        message: msg,
      }))
      results.errors++
    }
  }

  return jsonResponse(results)
})
