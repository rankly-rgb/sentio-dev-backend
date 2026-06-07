import { describe, it, expect } from 'vitest'

// ── Types miroir (churn-alert/index.ts) ───────────────────────

interface CriticalAccount {
  id: string
  stripe_customer_id: string
  display_name: string | null
  mrr_cents: number
  churn_risk_score: number
  health_score: number
}

// ── Helpers miroir ────────────────────────────────────────────

function maskCustomerId(stripeCustomerId: string): string {
  return 'cus_***' + stripeCustomerId.slice(-3)
}

function formatAccountLabel(account: CriticalAccount): string {
  return account.display_name || maskCustomerId(account.stripe_customer_id)
}

function buildChurnAlertEmail(accounts: CriticalAccount[]): string {
  const n = accounts.length
  const rows = accounts.map(a => {
    const label = formatAccountLabel(a)
    const mrr = Math.round(a.mrr_cents / 100)
    return `
    <tr>
      <td>${label}</td>
      <td>${mrr}€/mois</td>
      <td>${a.health_score}/100</td>
      <td>${a.churn_risk_score}/100</td>
      <td><a href="https://app.sentioapp.io/dashboard/accounts/${a.id}">Voir →</a></td>
    </tr>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"></head>
<body>
  <h1>Alerte churn</h1>
  <p><strong>${n} compte${n > 1 ? 's' : ''}</strong> ${n > 1 ? 'viennent' : 'vient'} de passer en zone critique.</p>
  <table><thead><tr>
    <th>Compte</th><th>MRR</th><th>Santé</th><th>Risque</th><th>Action</th>
  </tr></thead><tbody>${rows}</tbody></table>
</body>
</html>`
}

// ── Fixtures ──────────────────────────────────────────────────

const baseAccount: CriticalAccount = {
  id: 'uuid-001',
  stripe_customer_id: 'cus_abcXYZ',
  display_name: 'Acme Corp',
  mrr_cents: 49900,
  churn_risk_score: 82,
  health_score: 18,
}

const anonymousAccount: CriticalAccount = {
  id: 'uuid-002',
  stripe_customer_id: 'cus_def456',
  display_name: null,
  mrr_cents: 9900,
  churn_risk_score: 75,
  health_score: 25,
}

// ── Tests ─────────────────────────────────────────────────────

describe('maskCustomerId', () => {
  it('retourne cus_*** + 3 derniers chars', () => {
    expect(maskCustomerId('cus_abcXYZ')).toBe('cus_***XYZ')
  })

  it('fonctionne avec un id court', () => {
    expect(maskCustomerId('cus_abc')).toBe('cus_***abc')
  })
})

describe('formatAccountLabel', () => {
  it('retourne display_name si non-null', () => {
    expect(formatAccountLabel(baseAccount)).toBe('Acme Corp')
  })

  it('retourne cus_***<3chars> si display_name est null', () => {
    expect(formatAccountLabel(anonymousAccount)).toBe('cus_***456')
  })
})

describe('buildChurnAlertEmail', () => {
  it('génère un email avec N comptes en sujet', () => {
    const html = buildChurnAlertEmail([baseAccount, anonymousAccount])
    expect(html).toContain('2 comptes')
    expect(html).toContain('viennent de passer')
  })

  it('singulier avec 1 compte', () => {
    const html = buildChurnAlertEmail([baseAccount])
    expect(html).toContain('1 compte')
    expect(html).toContain('vient de passer')
  })

  it('utilise display_name si disponible', () => {
    const html = buildChurnAlertEmail([baseAccount])
    expect(html).toContain('Acme Corp')
  })

  it('masque stripe_customer_id si display_name absent', () => {
    const html = buildChurnAlertEmail([anonymousAccount])
    expect(html).toContain('cus_***456')
    expect(html).not.toContain('cus_def456')
  })

  it('affiche le MRR en euros', () => {
    const html = buildChurnAlertEmail([baseAccount])
    expect(html).toContain('499€/mois')
  })

  it('affiche churn_risk_score et health_score', () => {
    const html = buildChurnAlertEmail([baseAccount])
    expect(html).toContain('82/100')
    expect(html).toContain('18/100')
  })

  it('inclut un lien vers le compte', () => {
    const html = buildChurnAlertEmail([baseAccount])
    expect(html).toContain('/dashboard/accounts/uuid-001')
  })

  describe('Zero-PII', () => {
    const piiAccount: CriticalAccount = {
      id: 'uuid-003',
      stripe_customer_id: 'cus_pii789',
      display_name: null,
      mrr_cents: 19900,
      churn_risk_score: 90,
      health_score: 10,
    }

    it('ne contient pas de symbole @ (email)', () => {
      const html = buildChurnAlertEmail([piiAccount])
      const bodyContent = html.replace(/href="[^"]*"/g, '').replace(/action="[^"]*"/g, '')
      expect(bodyContent).not.toMatch(/@/)
    })

    it('ne contient pas de champ "email" dans le payload', () => {
      const html = buildChurnAlertEmail([piiAccount])
      expect(html.toLowerCase()).not.toContain('"email"')
    })

    it('ne contient pas de "phone" dans le payload', () => {
      const html = buildChurnAlertEmail([piiAccount])
      expect(html.toLowerCase()).not.toContain('phone')
    })

    it('ne contient pas de "ip" comme donnée de compte', () => {
      const html = buildChurnAlertEmail([piiAccount])
      expect(html).not.toMatch(/"ip"/)
    })

    it('stripe_customer_id est masqué (jamais en clair)', () => {
      const html = buildChurnAlertEmail([piiAccount])
      expect(html).not.toContain('cus_pii789')
      expect(html).toContain('cus_***789')
    })
  })
})

describe('aucun email si liste vide', () => {
  it('produit un HTML valide avec 0 lignes', () => {
    const html = buildChurnAlertEmail([])
    expect(html).toContain('0 compte')
    expect(html).toContain('<tbody></tbody>')
  })
})
