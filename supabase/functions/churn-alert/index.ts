// ============================================================
// Edge Function : churn-alert
// Triggered daily at 06:00 UTC (after calculate-scores at 03:00 UTC)
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// POST /churn-alert
//   Auth : service_role Bearer (cron) ou appel manuel
//   Body : {} (vide)
//   Response 200 :
//     {
//       sent: number,     // nombre d'emails envoyés
//       skipped: number,  // orgs sans comptes critiques ou sans email
//       errors: number
//     }
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, jsonResponse, errorResponse } from '../_shared/supabase-client.ts'
import { sendEmail } from '../_shared/resend.ts'

const APP_URL = Deno.env.get('NEXT_PUBLIC_APP_URL') || 'https://app.sentioapp.io'

export interface CriticalAccount {
  id: string
  stripe_customer_id: string
  display_name: string | null
  mrr_cents: number
  churn_risk_score: number
  health_score: number
}

// ── Helpers exportés pour les tests ──────────────────────────

export function maskCustomerId(stripeCustomerId: string): string {
  return 'cus_***' + stripeCustomerId.slice(-3)
}

export function formatAccountLabel(account: CriticalAccount): string {
  return account.display_name || maskCustomerId(account.stripe_customer_id)
}

export function buildChurnAlertEmail(accounts: CriticalAccount[]): string {
  const n = accounts.length
  const rows = accounts.map(a => {
    const label = formatAccountLabel(a)
    const mrr = Math.round(a.mrr_cents / 100)
    return `
    <tr>
      <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0">${label}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;text-align:right">${mrr}€/mois</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;text-align:center">${a.health_score}/100</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;text-align:center;color:#dc2626;font-weight:600">${a.churn_risk_score}/100</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0">
        <a href="${APP_URL}/dashboard/accounts/${a.id}" style="color:#3b82f6;text-decoration:none">Voir →</a>
      </td>
    </tr>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><title>Alerte churn — Sentio AI</title></head>
<body style="font-family:sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#1a1a1a;background:#f8fafc">
  <div style="background:#fff;border-radius:8px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.08)">
    <div style="display:flex;align-items:center;margin-bottom:24px">
      <span style="font-size:28px;margin-right:12px">🚨</span>
      <h1 style="margin:0;color:#0f172a;font-size:22px">Alerte churn — Sentio AI</h1>
    </div>

    <p style="color:#475569;margin-bottom:24px">
      <strong style="color:#dc2626">${n} compte${n > 1 ? 's' : ''}</strong>
      ${n > 1 ? 'viennent' : 'vient'} de passer en zone critique dans votre portefeuille.
      Une action rapide peut réduire le risque de churn.
    </p>

    <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
      <thead>
        <tr style="background:#f1f5f9">
          <th style="padding:10px 8px;text-align:left;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em">Compte</th>
          <th style="padding:10px 8px;text-align:right;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em">MRR</th>
          <th style="padding:10px 8px;text-align:center;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em">Santé</th>
          <th style="padding:10px 8px;text-align:center;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em">Risque</th>
          <th style="padding:10px 8px;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em">Action</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div style="text-align:center;margin-top:32px">
      <a href="${APP_URL}/dashboard"
         style="background:#0f172a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;display:inline-block">
        Ouvrir Sentio →
      </a>
    </div>

    <hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0">
    <p style="color:#94a3b8;font-size:12px;text-align:center;margin:0">
      Sentio AI — Alerte automatique quotidienne.<br>
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
    console.error(JSON.stringify({ level: 'error', function_name: 'churn-alert', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  // Orgs avec alertes churn activées et email de notification configuré
  const { data: orgs, error: orgError } = await supabase
    .from('organizations')
    .select('id, notification_email, churn_alert_enabled')
    .eq('churn_alert_enabled', true)
    .not('notification_email', 'is', null)

  if (orgError) {
    console.error(JSON.stringify({ level: 'error', function_name: 'churn-alert', message: orgError.message }))
    return errorResponse('Failed to fetch organizations', 500)
  }

  const results = { sent: 0, skipped: 0, errors: 0 }

  for (const org of (orgs ?? [])) {
    if (!org.notification_email || !org.id) {
      results.skipped++
      continue
    }

    try {
      // Comptes passés en zone critique dans les dernières 24h
      const { data: criticalAccounts, error: acctError } = await supabase
        .from('accounts')
        .select('id, stripe_customer_id, display_name, mrr_cents, churn_risk_score, health_score')
        .eq('organization_id', org.id)
        .gte('churn_risk_score', 70)
        .gte('updated_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .gt('mrr_cents', 0)
        .order('churn_risk_score', { ascending: false })
        .order('mrr_cents', { ascending: false })
        .limit(20)

      if (acctError) {
        console.error(JSON.stringify({
          level: 'error',
          function_name: 'churn-alert',
          org_id: org.id,
          message: acctError.message,
        }))
        results.errors++
        continue
      }

      if (!criticalAccounts || criticalAccounts.length === 0) {
        results.skipped++
        continue
      }

      const n = criticalAccounts.length
      const emailResult = await sendEmail({
        to: org.notification_email,
        subject: `🚨 ${n} compte${n > 1 ? 's' : ''} en danger critique — Sentio AI`,
        html: buildChurnAlertEmail(criticalAccounts as CriticalAccount[]),
        from_name: 'Sentio AI',
      })

      if (emailResult.success) {
        results.sent++
        console.log(JSON.stringify({
          level: 'info',
          function_name: 'churn-alert',
          org_id: org.id,
          accounts_count: n,
          log_only: emailResult.log_only ?? false,
        }))
      } else {
        results.errors++
        console.error(JSON.stringify({
          level: 'error',
          function_name: 'churn-alert',
          org_id: org.id,
          message: emailResult.error,
        }))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(JSON.stringify({
        level: 'error',
        function_name: 'churn-alert',
        org_id: org.id,
        message: msg,
      }))
      results.errors++
    }
  }

  return jsonResponse(results)
})
