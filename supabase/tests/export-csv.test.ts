import { describe, it, expect } from 'vitest'

// ── Types miroir (export-csv/index.ts) ────────────────────────

interface AccountRow {
  id: string
  stripe_customer_id: string
  display_name: string | null
  mrr_cents: number | null
  health_score: number | null
  churn_risk_score: number | null
  expansion_score: number | null
  plan_tier: string | null
  seat_count: number | null
  contract_end_date: string | null
}

interface ContactInfo {
  email: string
  name: string
}

// ── Helpers miroir ────────────────────────────────────────────

function maskCustomerId(id: string): string {
  return `cus_***${id.slice(-3)}`
}

function escapeField(val: unknown): string {
  const str = String(val ?? '')
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function generateCsv(
  accounts: AccountRow[],
  emailMap: Map<string, ContactInfo>,
  includeEmail: boolean,
): string {
  const headers = [
    'Entreprise',
    'ID Stripe',
    ...(includeEmail ? ['Email'] : []),
    'MRR (€)',
    'Score santé',
    'Risque churn',
    'Score expansion',
    'Plan',
    'Seats',
    'Fin contrat',
  ]

  const rows = accounts.map((account) => {
    const contact = emailMap.get(account.stripe_customer_id ?? '')
    const displayName = account.display_name
      ?? contact?.name
      ?? maskCustomerId(account.stripe_customer_id ?? '')

    return [
      displayName,
      account.stripe_customer_id ?? '',
      ...(includeEmail ? [contact?.email ?? ''] : []),
      ((account.mrr_cents ?? 0) / 100).toFixed(2),
      account.health_score ?? '',
      account.churn_risk_score ?? '',
      account.expansion_score ?? '',
      account.plan_tier ?? '',
      account.seat_count ?? '',
      account.contract_end_date ?? '',
    ]
  })

  return [headers, ...rows]
    .map((row) => row.map(escapeField).join(','))
    .join('\n')
}

// ── Fixtures ──────────────────────────────────────────────────

const accountA: AccountRow = {
  id: 'uuid-001',
  stripe_customer_id: 'cus_ABC123',
  display_name: 'Acme Corp',
  mrr_cents: 49900,
  health_score: 32,
  churn_risk_score: 78,
  expansion_score: 15,
  plan_tier: 'growth',
  seat_count: 5,
  contract_end_date: '2026-12-31',
}

const accountB: AccountRow = {
  id: 'uuid-002',
  stripe_customer_id: 'cus_XYZ789',
  display_name: null,
  mrr_cents: 9900,
  health_score: 55,
  churn_risk_score: 45,
  expansion_score: 60,
  plan_tier: 'starter',
  seat_count: 2,
  contract_end_date: null,
}

const emailMap = new Map<string, ContactInfo>([
  ['cus_ABC123', { email: 'contact@acme.com', name: 'Acme Corp' }],
  ['cus_XYZ789', { email: 'user@beta.io', name: 'Beta Inc' }],
])

const emptyMap = new Map<string, ContactInfo>()

// ── Tests generateCsv ─────────────────────────────────────────

describe('generateCsv', () => {
  it('contient les colonnes obligatoires avec email', () => {
    const csv = generateCsv([accountA], emailMap, true)
    const header = csv.split('\n')[0]
    expect(header).toContain('Entreprise')
    expect(header).toContain('ID Stripe')
    expect(header).toContain('Email')
    expect(header).toContain('MRR (€)')
    expect(header).toContain('Score santé')
    expect(header).toContain('Risque churn')
    expect(header).toContain('Score expansion')
    expect(header).toContain('Plan')
    expect(header).toContain('Seats')
    expect(header).toContain('Fin contrat')
  })

  it('exclut la colonne Email si include_email=false', () => {
    const csv = generateCsv([accountA], emptyMap, false)
    const header = csv.split('\n')[0]
    expect(header).not.toContain('Email')
    expect(header).toContain('Entreprise')
  })

  it('utilise display_name si disponible', () => {
    const csv = generateCsv([accountA], emailMap, true)
    expect(csv).toContain('Acme Corp')
  })

  it('utilise le nom Stripe si display_name est null', () => {
    const csv = generateCsv([accountB], emailMap, true)
    expect(csv).toContain('Beta Inc')
  })

  it('masque le nom affiché si display_name et name Stripe absents', () => {
    const csv = generateCsv([accountB], emptyMap, false)
    const lines = csv.split('\n')
    const header = lines[0].split(',')
    const entrepriseIdx = header.indexOf('Entreprise')
    const dataFields = lines[1].split(',')
    // La colonne Entreprise doit être masquée
    expect(dataFields[entrepriseIdx]).toBe('cus_***789')
    // La colonne ID Stripe garde l'ID en clair (identifiant anonyme, pas PII)
    const idStripeIdx = header.indexOf('ID Stripe')
    expect(dataFields[idStripeIdx]).toBe('cus_XYZ789')
  })

  it('convertit mrr_cents en euros (2 décimales)', () => {
    const csv = generateCsv([accountA], emptyMap, false)
    expect(csv).toContain('499.00')
  })

  it('inclut l\'email Stripe dans la ligne si include_email=true', () => {
    const csv = generateCsv([accountA], emailMap, true)
    expect(csv).toContain('contact@acme.com')
  })

  it('colonne email vide si emailMap vide et include_email=true', () => {
    const csv = generateCsv([accountA], emptyMap, true)
    const lines = csv.split('\n')
    const dataLine = lines[1].split(',')
    const emailIdx = lines[0].split(',').indexOf('Email')
    expect(dataLine[emailIdx]).toBe('')
  })

  it('génère N+1 lignes (header + N comptes)', () => {
    const csv = generateCsv([accountA, accountB], emailMap, true)
    expect(csv.split('\n').length).toBe(3)
  })

  it('génère une ligne de header seule si 0 comptes', () => {
    const csv = generateCsv([], emptyMap, true)
    expect(csv.split('\n').length).toBe(1)
  })

  it('échappe les virgules dans les valeurs', () => {
    const accountWithComma: AccountRow = { ...accountA, display_name: 'Acme, Corp' }
    const csv = generateCsv([accountWithComma], emptyMap, false)
    expect(csv).toContain('"Acme, Corp"')
  })

  it('échappe les guillemets dans les valeurs', () => {
    const accountWithQuote: AccountRow = { ...accountA, display_name: 'Acme "Corp"' }
    const csv = generateCsv([accountWithQuote], emptyMap, false)
    expect(csv).toContain('"Acme ""Corp"""')
  })
})

// ── Tests escapeField ─────────────────────────────────────────

describe('escapeField', () => {
  it('ne quote pas les valeurs simples', () => {
    expect(escapeField('hello')).toBe('hello')
  })

  it('quote les valeurs avec virgule', () => {
    expect(escapeField('hello, world')).toBe('"hello, world"')
  })

  it('double les guillemets dans les valeurs quotées', () => {
    expect(escapeField('say "hi"')).toBe('"say ""hi"""')
  })

  it('convertit null en chaîne vide', () => {
    expect(escapeField(null)).toBe('')
  })

  it('convertit undefined en chaîne vide', () => {
    expect(escapeField(undefined)).toBe('')
  })
})

// ── Tests maskCustomerId ──────────────────────────────────────

describe('maskCustomerId', () => {
  it('retourne cus_*** + 3 derniers chars', () => {
    expect(maskCustomerId('cus_ABC123')).toBe('cus_***123')
  })
})

// ── Tests Zero-PII ────────────────────────────────────────────

describe('Zero-PII — emails uniquement dans le CSV, jamais ailleurs', () => {
  it('l\'email n\'apparaît pas dans le nom affiché', () => {
    const csv = generateCsv([accountA], emailMap, false)
    expect(csv).not.toContain('@')
  })

  it('l\'email apparaît uniquement dans la colonne Email quand activée', () => {
    const csv = generateCsv([accountA], emailMap, true)
    const lines = csv.split('\n')
    const header = lines[0].split(',')
    const emailIdx = header.indexOf('Email')
    // Seule la colonne Email doit contenir @
    lines.slice(1).forEach((line) => {
      const fields = line.split(',')
      fields.forEach((field, idx) => {
        if (idx !== emailIdx) {
          expect(field).not.toMatch(/@/)
        }
      })
    })
  })

  it('la colonne Entreprise est masquée si display_name absent (pas la colonne ID Stripe)', () => {
    const csv = generateCsv([accountB], emptyMap, false)
    const lines = csv.split('\n')
    const header = lines[0].split(',')
    const entrepriseIdx = header.indexOf('Entreprise')
    const fields = lines[1].split(',')
    // Colonne Entreprise : masquée
    expect(fields[entrepriseIdx]).toBe('cus_***789')
    // stripe_customer_id reste dans la colonne ID Stripe (identifiant anonyme)
    expect(csv).toContain('cus_XYZ789')
  })

  it('la colonne ID Stripe est toujours en clair (identifiant anonyme)', () => {
    const csv = generateCsv([accountA], emptyMap, false)
    expect(csv).toContain('cus_ABC123')
  })
})
