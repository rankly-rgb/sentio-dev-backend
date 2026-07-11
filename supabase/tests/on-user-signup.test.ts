import { describe, it, expect } from 'vitest'

// ── Fonctions pures miroir (on-user-signup/index.ts) ──────────

function formatTrialEndDate(trialEndsAt: string | null): string {
  if (!trialEndsAt) return '14 days'
  const date = new Date(trialEndsAt)
  if (isNaN(date.getTime())) return '14 days'
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

function buildWelcomeEmail(orgName: string, trialEndsAt: string | null): string {
  const trialDate = formatTrialEndDate(trialEndsAt)
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Welcome to Sentio AI</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1a1a1a">
  <h1 style="color:#0f172a">Welcome to Sentio AI 👋</h1>
  <p>Your <strong>${orgName}</strong> workspace is ready. Your free trial runs until <strong>${trialDate}</strong>.</p>
  <h2 style="color:#0f172a;margin-top:32px">Your first 3 steps</h2>
  <ol>
    <li style="margin-bottom:12px"><strong>Connect Stripe</strong> — import your subscriptions in 2 minutes.</li>
    <li style="margin-bottom:12px"><strong>Connect HubSpot</strong> (optional) — enrich your engagement data.</li>
    <li style="margin-bottom:12px"><strong>Discover your aha moment</strong> — identify at-risk accounts in real time.</li>
  </ol>
  <a href="https://app.sentio.ai/dashboard/onboarding"
     style="display:inline-block;margin-top:24px;padding:12px 24px;background:#0f172a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">
    Go to dashboard
  </a>
  <p style="margin-top:40px;font-size:13px;color:#6b7280">
    You received this email because you just created a Sentio AI account.<br>
    Questions? Reply directly to this email.
  </p>
</body>
</html>`
}

function validateOrgData(org: unknown): { valid: boolean; error?: string } {
  if (org === null || org === undefined) return { valid: false, error: 'Organization is required' }
  if (typeof org !== 'object') return { valid: false, error: 'Organization must be an object' }
  return { valid: true }
}

// ── Tests buildWelcomeEmail ─────────────────────────────────

describe('on-user-signup: buildWelcomeEmail', () => {
  it("contient le nom de l'organisation", () => {
    const html = buildWelcomeEmail('Acme Corp', null)
    expect(html).toContain('Acme Corp')
  })

  it('contient la date de fin d\'essai formatée quand trial_ends_at est fourni', () => {
    const html = buildWelcomeEmail('Acme', '2026-05-17T00:00:00Z')
    expect(html).toContain('2026')
    expect(html).not.toBe('14 days')
  })

  it('ne contient pas d\'adresse email (Zero-PII)', () => {
    const html = buildWelcomeEmail('Acme Corp', null)
    expect(html).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/)
  })

  it('contient un lien vers /dashboard/onboarding', () => {
    const html = buildWelcomeEmail('Acme Corp', null)
    expect(html).toContain('/dashboard/onboarding')
  })

  it('est en anglais (lang="en")', () => {
    const html = buildWelcomeEmail('Acme', null)
    expect(html).toContain('lang="en"')
    expect(html).toContain('Welcome')
  })

  it('affiche "14 days" quand trial_ends_at est null', () => {
    const html = buildWelcomeEmail('Acme', null)
    expect(html).toContain('14 days')
  })
})

// ── Tests formatTrialEndDate ──────────────────────────────────

describe('on-user-signup: formatTrialEndDate', () => {
  it('formate une date ISO en date lisible en anglais', () => {
    const result = formatTrialEndDate('2026-05-17T00:00:00Z')
    expect(result).toContain('2026')
    expect(result).not.toBe('14 days')
  })

  it('retourne "14 days" si trial_ends_at est null', () => {
    expect(formatTrialEndDate(null)).toBe('14 days')
  })

  it('retourne "14 days" si trial_ends_at est une chaîne invalide', () => {
    expect(formatTrialEndDate('not-a-date')).toBe('14 days')
  })
})

// ── Tests validateOrgData ─────────────────────────────────────

describe('on-user-signup: validateOrgData', () => {
  it('valide un objet org complet', () => {
    const result = validateOrgData({ id: 'uuid', name: 'Acme', plan_type: 'free', trial_ends_at: null })
    expect(result.valid).toBe(true)
  })

  it('valide un org sans trial_ends_at (graceful)', () => {
    const result = validateOrgData({ id: 'uuid', name: 'Acme' })
    expect(result.valid).toBe(true)
  })

  it('rejette null', () => {
    const result = validateOrgData(null)
    expect(result.valid).toBe(false)
    expect(result.error).toBe('Organization is required')
  })
})
