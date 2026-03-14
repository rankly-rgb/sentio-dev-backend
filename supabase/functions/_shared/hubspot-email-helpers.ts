// ============================================================
// HubSpot Email Helpers — Fonctions pures testables avec Vitest
// Pas d'imports Deno/jsr — construction de payloads HubSpot Email API
// Zero-PII : Sentio envoie hubspot_company_id + scores,
// HubSpot résout le contact et envoie l'email.
// ============================================================

/** Input for sending a HubSpot email via CRM API */
export interface HubSpotEmailInput {
  /** Email subject (supports variable substitution) */
  subject: string
  /** HTML body (supports variable substitution) */
  body_html: string
  /** Email direction — always FORWARDED_EMAIL for automated sends */
  email_direction?: 'FORWARDED_EMAIL' | 'INCOMING_EMAIL' | 'EMAIL'
  /** Email status — DRAFT creates a draft the CSM can review, SEND logs as sent. Default: DRAFT */
  email_status?: 'DRAFT' | 'SEND'
}

/** Result of a HubSpot email engagement creation */
export interface HubSpotEmailResult {
  emailId: string
  associationSuccess: boolean
}

/** Variables available for template substitution */
export interface EmailTemplateVars {
  stripe_customer_id?: string | null
  health_score?: number | null
  churn_risk_score?: number | null
  expansion_score?: number | null
  mrr_cents?: number | null
  playbook_title?: string | null
}

/** Association type ID for email-to-company in HubSpot v4 API */
const EMAIL_TO_COMPANY_ASSOCIATION_TYPE_ID = 186

/**
 * Substitutes template variables in a string.
 * Replaces {variable_name} with actual values.
 * Null/undefined values become "N/A".
 *
 * @param template - String with {variable} placeholders
 * @param vars - Variable values to substitute
 * @returns String with substituted values
 */
export function substituteEmailVars(
  template: string,
  vars: EmailTemplateVars,
): string {
  if (!template) return ''

  const mrrEur = vars.mrr_cents != null ? (vars.mrr_cents / 100).toFixed(0) : 'N/A'

  return template
    .replace(/\{stripe_customer_id\}/g, vars.stripe_customer_id ?? 'N/A')
    .replace(/\{health_score\}/g, vars.health_score != null ? String(vars.health_score) : 'N/A')
    .replace(/\{churn_risk\}/g, vars.churn_risk_score != null ? String(vars.churn_risk_score) : 'N/A')
    .replace(/\{churn_risk_score\}/g, vars.churn_risk_score != null ? String(vars.churn_risk_score) : 'N/A')
    .replace(/\{expansion_score\}/g, vars.expansion_score != null ? String(vars.expansion_score) : 'N/A')
    .replace(/\{mrr_eur\}/g, mrrEur)
    .replace(/\{mrr_cents\}/g, vars.mrr_cents != null ? String(vars.mrr_cents) : 'N/A')
    .replace(/\{playbook\}/g, vars.playbook_title ?? 'N/A')
    .replace(/\{playbook_title\}/g, vars.playbook_title ?? 'N/A')
}

/**
 * Builds the HubSpot API request body for creating an email engagement.
 * Uses the HubSpot CRM v3 objects/emails endpoint format.
 *
 * @param input - Email input with subject and body_html
 * @param vars - Template variables for substitution
 * @param nowMs - Current timestamp in ms (injectable for testing)
 * @returns Properties object for HubSpot POST /crm/v3/objects/emails
 */
export function buildHubSpotEmailBody(
  input: HubSpotEmailInput,
  vars: EmailTemplateVars,
  nowMs?: number,
): { properties: Record<string, string | number> } {
  const now = nowMs ?? Date.now()

  const subject = substituteEmailVars(input.subject, vars)
  const bodyHtml = substituteEmailVars(input.body_html, vars)

  return {
    properties: {
      hs_timestamp: now,
      hs_email_direction: input.email_direction ?? 'FORWARDED_EMAIL',
      hs_email_subject: subject,
      hs_email_html: bodyHtml,
      hs_email_status: input.email_status ?? 'DRAFT',
    },
  }
}

/**
 * Builds the HubSpot v4 associations batch/create request body.
 * Links an email to a company using association type 186 (email_to_company).
 *
 * @param emailId - HubSpot email ID (from email creation response)
 * @param companyId - HubSpot company ID to associate with
 * @returns Request body for POST /crm/v4/associations/emails/companies/batch/create
 */
export function buildEmailAssociationBody(
  emailId: string,
  companyId: string,
): { inputs: Array<{ from: { id: string }; to: { id: string }; types: Array<{ associationCategory: string; associationTypeId: number }> }> } {
  return {
    inputs: [
      {
        from: { id: emailId },
        to: { id: companyId },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: EMAIL_TO_COMPANY_ASSOCIATION_TYPE_ID,
          },
        ],
      },
    ],
  }
}

/**
 * Extracts the email ID from a HubSpot CRM v3 email creation response.
 * Returns null if the response is invalid or missing the id field.
 *
 * @param response - Parsed JSON response from HubSpot API
 * @returns Email ID string or null
 */
export function parseHubSpotEmailId(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null
  const obj = response as Record<string, unknown>
  if (!obj.id || typeof obj.id !== 'string') return null
  return obj.id
}

/**
 * Builds a default email subject from account data when no custom subject is provided.
 *
 * @param playbookTitle - Title of the playbook
 * @returns Default subject string
 */
export function buildDefaultEmailSubject(playbookTitle: string): string {
  return `[Sentio] Action requise — ${playbookTitle}`
}

/**
 * Builds a default email HTML body from account scores (Zero-PII).
 *
 * @param vars - Template variables with scores
 * @param playbookTitle - Title of the playbook
 * @returns Default HTML body string
 */
export function buildDefaultEmailBody(
  vars: EmailTemplateVars,
  playbookTitle: string,
): string {
  const parts: string[] = []
  if (vars.churn_risk_score != null) parts.push(`Risque de churn : ${vars.churn_risk_score}%`)
  if (vars.health_score != null) parts.push(`Score de sante : ${vars.health_score}`)
  if (vars.mrr_cents != null) parts.push(`MRR : ${(vars.mrr_cents / 100).toFixed(0)} EUR`)
  if (vars.expansion_score != null) parts.push(`Score expansion : ${vars.expansion_score}`)

  const metricsHtml = parts.length > 0
    ? `<ul>${parts.map(p => `<li>${p}</li>`).join('')}</ul>`
    : '<p>Aucune metrique disponible.</p>'

  return `<div>
<h3>${playbookTitle}</h3>
<p>Ce compte necessite votre attention :</p>
${metricsHtml}
<p><em>Email genere automatiquement par Sentio AI</em></p>
</div>`
}
