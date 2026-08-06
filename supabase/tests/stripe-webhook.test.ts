import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ── T013 : non-régression du hook fire-and-forget ajouté en T015 ──
//
// `stripe-webhook/index.ts` n'exporte aucun handler testable directement
// (toute la logique — vérification de signature HMAC, dispatch, DLQ —
// vit dans le corps de `Deno.serve(...)`, non extrait, cf. gouvernance
// "ajout ciblé, jamais une réécriture" appliquée au diff T015). Ce fichier
// est donc NOUVEAU (tasks.md prévoyait "fichier existant, ajout de cas" —
// aucun `supabase/tests/stripe-webhook.test.ts` n'existait avant ce
// chantier, écart signalé).
//
// À défaut d'un handler exporté, ces tests vérifient par inspection du
// code source (1) que `handleInvoiceEvent` est toujours appelé pour les
// trois event-types facture (`invoice.created`, `invoice.paid`,
// `invoice.voided`) — la fonction elle-même est prouvée inchangée par
// une revue de diff dédiée (T035) — et (2) que le hook fire-and-forget
// ajouté par T015 ne se déclenche que pour `invoice.paid`, jamais pour
// `invoice.created`/`invoice.voided` (SC-003 : comportement inchangé
// pour un compte sans exécution en attente).

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(__dirname, '../functions/stripe-webhook/index.ts'), 'utf-8')

function extractCaseBlock(source: string, caseLabel: string): string {
  const marker = `case '${caseLabel}':`
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`case '${caseLabel}' not found`)
  const breakIdx = source.indexOf('break', start)
  return source.slice(start, breakIdx)
}

describe('stripe-webhook — invoice event dispatch (non-regression, T013)', () => {
  it('invoice.created and invoice.voided still call handleInvoiceEvent, with no side effect', () => {
    const block = extractCaseBlock(source, 'invoice.created')
    expect(block).toContain("case 'invoice.voided':")
    expect(block).toContain('await handleInvoiceEvent(supabase, organizationId, event, logger)')
    expect(block).not.toContain('fetch(')
    expect(block).not.toContain('playbook-outcome-detector')
  })

  it('invoice.paid still calls handleInvoiceEvent, plus the new fire-and-forget hook', () => {
    const block = extractCaseBlock(source, 'invoice.paid')
    expect(block).toContain('await handleInvoiceEvent(supabase, organizationId, event, logger)')
    expect(block).toContain('playbook-outcome-detector')
  })

  it('the invoice.paid hook is a non-awaited fetch (fire-and-forget), never blocking the response', () => {
    const block = extractCaseBlock(source, 'invoice.paid')
    // Le fetch() ne doit jamais être précédé de `await` — sinon il
    // bloquerait la réponse au webhook Stripe.
    expect(block).not.toMatch(/await\s+fetch\(/)
    expect(block).toContain('.catch(')
  })

  it('invoice.payment_failed still targets playbook-executor (untouched sibling hook)', () => {
    const block = extractCaseBlock(source, 'invoice.payment_failed')
    expect(block).toContain('playbook-executor')
    expect(block).not.toContain('playbook-outcome-detector')
  })

  it('handleInvoiceEvent itself is untouched — only the switch dispatch changed (cf. T035 diff review)', () => {
    // Signature stable : mêmes 4 paramètres qu'avant ce chantier.
    expect(source).toContain('async function handleInvoiceEvent(')
    const fnStart = source.indexOf('async function handleInvoiceEvent(')
    const fnSignatureEnd = source.indexOf(')', fnStart)
    const signature = source.slice(fnStart, fnSignatureEnd)
    expect(signature).toContain('supabase')
    expect(signature).toContain('organizationId')
    expect(signature).toContain('event')
    expect(signature).toContain('logger')
  })
})
