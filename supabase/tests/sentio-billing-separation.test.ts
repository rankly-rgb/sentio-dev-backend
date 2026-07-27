import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ── T020 : garde-fou de séparation stricte des deux intégrations Stripe ──
// (cf. specs/003-pricing-billing-implementation/research.md, risque
// critique). Aucun fichier `sentio-billing-*` ne doit référencer les
// identifiants de l'intégration Stripe existante (données clients).

const __dirname = dirname(fileURLToPath(import.meta.url))
const functionsDir = join(__dirname, '../functions')

const FORBIDDEN_IDENTIFIERS = ['STRIPE_SECRET_KEY', 'STRIPE_CLIENT_ID', 'STRIPE_WEBHOOK_SECRET']

function listSentioBillingSourceFiles(): string[] {
  const dirs = readdirSync(functionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('sentio-billing-'))
    .map((d) => d.name)

  return dirs.map((dir) => join(functionsDir, dir, 'index.ts'))
}

describe('sentio-billing-* — Stripe integration separation guard', () => {
  const files = listSentioBillingSourceFiles()

  it('found at least one sentio-billing-* function to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)('%s does not reference any client-Stripe-integration secret', (filePath) => {
    const source = readFileSync(filePath, 'utf-8')
    for (const identifier of FORBIDDEN_IDENTIFIERS) {
      expect(source).not.toContain(identifier)
    }
  })

  it.each(files)('%s only reads STRIPE_BILLING_* environment variables via Deno.env.get', (filePath) => {
    const source = readFileSync(filePath, 'utf-8')
    const envGetCalls = [...source.matchAll(/Deno\.env\.get\(['"]([A-Z_]+)['"]\)/g)].map((m) => m[1])
    for (const varName of envGetCalls) {
      expect(varName.startsWith('STRIPE_BILLING_')).toBe(true)
    }
  })
})
