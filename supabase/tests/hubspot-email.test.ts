// ============================================================
// Tests : HubSpot Email Helpers — fonctions pures
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  substituteEmailVars,
  buildHubSpotEmailBody,
  buildEmailAssociationBody,
  parseHubSpotEmailId,
  buildDefaultEmailSubject,
  buildDefaultEmailBody,
  type EmailTemplateVars,
} from '../functions/_shared/hubspot-email-helpers'

// ── substituteEmailVars ─────────────────────────────────────

describe('substituteEmailVars', () => {
  const vars: EmailTemplateVars = {
    stripe_customer_id: 'cus_abc123',
    health_score: 45,
    churn_risk_score: 72,
    expansion_score: 30,
    mrr_cents: 49900,
    playbook_title: 'Prevention churn',
  }

  it('substitutes all variables', () => {
    const template = 'Client {stripe_customer_id} — Churn: {churn_risk}% — Sante: {health_score} — MRR: {mrr_eur} EUR — Playbook: {playbook}'
    const result = substituteEmailVars(template, vars)
    expect(result).toBe('Client cus_abc123 — Churn: 72% — Sante: 45 — MRR: 499 EUR — Playbook: Prevention churn')
  })

  it('replaces null values with N/A', () => {
    const result = substituteEmailVars('{health_score} - {churn_risk}', {
      health_score: null,
      churn_risk_score: null,
    })
    expect(result).toBe('N/A - N/A')
  })

  it('handles empty template', () => {
    expect(substituteEmailVars('', vars)).toBe('')
  })

  it('handles undefined values', () => {
    const result = substituteEmailVars('{stripe_customer_id} {mrr_eur}', {})
    expect(result).toBe('N/A N/A')
  })

  it('supports {churn_risk_score} alias', () => {
    const result = substituteEmailVars('{churn_risk_score}', { churn_risk_score: 85 })
    expect(result).toBe('85')
  })

  it('supports {playbook_title} alias', () => {
    const result = substituteEmailVars('{playbook_title}', { playbook_title: 'Test PB' })
    expect(result).toBe('Test PB')
  })

  it('replaces multiple occurrences', () => {
    const result = substituteEmailVars('{health_score}/{health_score}', { health_score: 50 })
    expect(result).toBe('50/50')
  })
})

// ── buildHubSpotEmailBody ──────────────────────────────────

describe('buildHubSpotEmailBody', () => {
  const vars: EmailTemplateVars = {
    health_score: 45,
    churn_risk_score: 72,
    mrr_cents: 49900,
  }

  it('builds correct properties structure', () => {
    const result = buildHubSpotEmailBody(
      { subject: 'Test subject', body_html: '<p>Test</p>' },
      vars,
      1700000000000,
    )
    expect(result.properties.hs_email_subject).toBe('Test subject')
    expect(result.properties.hs_email_html).toBe('<p>Test</p>')
    expect(result.properties.hs_email_direction).toBe('FORWARDED_EMAIL')
    expect(result.properties.hs_email_status).toBe('SEND')
    expect(result.properties.hs_timestamp).toBe(1700000000000)
  })

  it('substitutes variables in subject and body', () => {
    const result = buildHubSpotEmailBody(
      { subject: 'Alerte {health_score}', body_html: '<p>Churn: {churn_risk}%</p>' },
      vars,
    )
    expect(result.properties.hs_email_subject).toBe('Alerte 45')
    expect(result.properties.hs_email_html).toBe('<p>Churn: 72%</p>')
  })

  it('respects custom email_direction', () => {
    const result = buildHubSpotEmailBody(
      { subject: 'Test', body_html: '', email_direction: 'EMAIL' },
      vars,
    )
    expect(result.properties.hs_email_direction).toBe('EMAIL')
  })
})

// ── buildEmailAssociationBody ──────────────────────────────

describe('buildEmailAssociationBody', () => {
  it('builds correct association structure', () => {
    const result = buildEmailAssociationBody('email-123', 'company-456')
    expect(result.inputs).toHaveLength(1)
    expect(result.inputs[0].from.id).toBe('email-123')
    expect(result.inputs[0].to.id).toBe('company-456')
    expect(result.inputs[0].types[0].associationCategory).toBe('HUBSPOT_DEFINED')
    expect(result.inputs[0].types[0].associationTypeId).toBe(186)
  })
})

// ── parseHubSpotEmailId ────────────────────────────────────

describe('parseHubSpotEmailId', () => {
  it('extracts id from valid response', () => {
    expect(parseHubSpotEmailId({ id: '12345', properties: {} })).toBe('12345')
  })

  it('returns null for missing id', () => {
    expect(parseHubSpotEmailId({ properties: {} })).toBeNull()
  })

  it('returns null for non-string id', () => {
    expect(parseHubSpotEmailId({ id: 12345 })).toBeNull()
  })

  it('returns null for null response', () => {
    expect(parseHubSpotEmailId(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(parseHubSpotEmailId(undefined)).toBeNull()
  })
})

// ── buildDefaultEmailSubject ───────────────────────────────

describe('buildDefaultEmailSubject', () => {
  it('includes playbook title', () => {
    const result = buildDefaultEmailSubject('Prevention churn')
    expect(result).toContain('Prevention churn')
    expect(result).toContain('[Sentio]')
  })
})

// ── buildDefaultEmailBody ──────────────────────────────────

describe('buildDefaultEmailBody', () => {
  it('includes all available metrics', () => {
    const result = buildDefaultEmailBody(
      { churn_risk_score: 72, health_score: 45, mrr_cents: 49900, expansion_score: 30 },
      'Prevention churn',
    )
    expect(result).toContain('72%')
    expect(result).toContain('45')
    expect(result).toContain('499 EUR')
    expect(result).toContain('30')
    expect(result).toContain('Prevention churn')
  })

  it('handles null scores gracefully', () => {
    const result = buildDefaultEmailBody(
      { churn_risk_score: null, health_score: null, mrr_cents: null, expansion_score: null },
      'Test',
    )
    expect(result).toContain('Aucune metrique')
    expect(result).not.toContain('null')
  })

  it('does not contain PII fields', () => {
    const result = buildDefaultEmailBody(
      { churn_risk_score: 72, health_score: 45, mrr_cents: 49900 },
      'Test',
    )
    // No personal data: no @email, no phone numbers, no names, no addresses
    expect(result).not.toMatch(/@[a-z]+\.[a-z]/i)
    expect(result).not.toMatch(/phone|telephone|adresse|address/i)
  })

  it('includes Sentio attribution', () => {
    const result = buildDefaultEmailBody({}, 'Test')
    expect(result).toContain('Sentio AI')
  })
})
