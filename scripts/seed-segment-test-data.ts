/**
 * seed-segment-test-data.ts
 * Crée des clients Stripe test-mode configurés pour atterrir dans un segment
 * précis une fois synchronisés dans Sentio, afin de valider la distribution
 * réelle des 9 segments (`docs/SEGMENT_CRITERIA_AUDIT.md`).
 *
 * Usage :
 *   STRIPE_SECRET_KEY=sk_test_xxx npx tsx scripts/seed-segment-test-data.ts --phase=1
 *   → puis déclencher une 1re sync Sentio (voir le résumé affiché en fin de script)
 *   STRIPE_SECRET_KEY=sk_test_xxx npx tsx scripts/seed-segment-test-data.ts --phase=2
 *   → puis déclencher une 2e sync Sentio
 *
 * Pourquoi deux phases : Champions (`champions`) exige un signal d'expansion
 * MRR et Critical (`en_danger_critique`) atteint son seuil via une contraction
 * MRR — les deux sont détectés par `sync-stripe` en comparant le MRR courant
 * au MRR de la sync PRÉCÉDENTE (`mrr_movements`, généré côté Sentio, pas Stripe).
 * Un abonnement qui change de prix avant la toute première sync ne produit
 * jamais 'expansion'/'contraction', seulement 'new'. La phase 2 modifie donc
 * le prix des abonnements Champions/Critical *après* qu'une 1re sync ait posé
 * la ligne `accounts.mrr_cents` de référence.
 *
 * Segments volontairement exclus (voir SEGMENT_CRITERIA_AUDIT.md) :
 *   - `en_expansion` (Expanding) : retiré en V3, plus jamais assigné par le code.
 *   - `donnees_insuffisantes` (Insufficient data) : structurellement inatteignable
 *     via une sync Stripe normale (bug documenté, pas corrigé ici).
 *   - `nouveaux` (New <90d) : non-exclusif, satisfait automatiquement par TOUT
 *     compte fraîchement créé — inclure une cohorte dédiée doublonnerait les
 *     6 autres cohortes plutôt que d'en ajouter une distincte.
 *
 * Prérequis :
 *   - STRIPE_SECRET_KEY dans l'environnement (jamais en dur, jamais en argument CLI)
 *   - npm install -D stripe tsx (si pas déjà installé)
 */

import Stripe from 'stripe'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY
if (!STRIPE_SECRET_KEY) {
  console.error(
    '\n❌ STRIPE_SECRET_KEY absente de l\'environnement.\n' +
      '   Ce script ne lit JAMAIS la clé en dur ni en argument CLI — exporte-la avant de lancer :\n' +
      '   export STRIPE_SECRET_KEY=sk_test_...\n',
  )
  process.exit(1)
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })

// Compte connecté attendu (Settings → Integrations côté Sentio). Si la clé
// fournie pointe vers un autre compte Stripe, sync-stripe ne verra jamais ces
// clients — on vérifie avant de créer quoi que ce soit plutôt que de laisser
// l'utilisateur découvrir 0 nouveau compte après coup.
const EXPECTED_ACCOUNT_ID = 'acct_1T65u2GgVJXswNCn'

const PER_SEGMENT = 50
const CONCURRENCY = 5
const INTER_CHUNK_DELAY_MS = 300

const STATE_FILE = join(process.cwd(), 'scripts', '.seed-segment-state.json')

type SegmentKey = 'stables' | 'champions' | 'en_danger_critique' | 'a_risque_leger' | 'impayes' | 'en_churn'

const SEGMENTS: Array<{ key: SegmentKey; label: string }> = [
  { key: 'stables', label: 'Stable' },
  { key: 'champions', label: 'Champions' },
  { key: 'en_danger_critique', label: 'Critical' },
  { key: 'a_risque_leger', label: 'At risk' },
  { key: 'impayes', label: 'Overdue' },
  { key: 'en_churn', label: 'Churned' },
]

interface SeedRecord {
  segment: SegmentKey
  index: number
  customerId: string
  subscriptionId: string | null
  subscriptionItemId: string | null
}

interface PriceSet {
  annualBase: string // Stable / Champions (phase 1) — $2,990/yr
  annualUpgrade: string // Champions (phase 2) — $4,990/yr, déclenche 'expansion'
  monthlyBase: string // Critical / At risk / Overdue / Churned — $299/mo
  monthlyDowngrade: string // Critical (phase 2) — $199/mo, déclenche 'contraction' (-33%)
}

interface SeedState {
  createdAt: string
  prices: PriceSet
  records: SeedRecord[]
}

// ─── Utilitaires ─────────────────────────────────────────────────────────────
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Retry + backoff exponentiel sur 429/5xx uniquement (mêmes codes que
// _shared/retry-with-backoff.ts côté Edge Functions, adapté ici pour le SDK Stripe).
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 4): Promise<T> {
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      const isStripeError = err instanceof Stripe.errors.StripeError
      const status = isStripeError ? (err as Stripe.errors.StripeError).statusCode : undefined
      const retryable = status === 429 || (status !== undefined && status >= 500)
      attempt++
      if (!retryable || attempt > maxRetries) throw err
      const delay = Math.min(1000 * 2 ** attempt, 15000) + Math.floor(Math.random() * 300)
      console.warn(`  ⏳ Retry ${attempt}/${maxRetries} après erreur ${status} — attente ${delay}ms`)
      await sleep(delay)
    }
  }
}

function loadState(): SeedState {
  if (!existsSync(STATE_FILE)) {
    console.error(`❌ Aucun état de phase 1 trouvé (${STATE_FILE}). Lance --phase=1 d'abord.`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as SeedState
}

function saveState(state: SeedState) {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

async function verifyConnectedAccount(): Promise<void> {
  const account = await withRetry(() => stripe.accounts.retrieve())
  if (account.id !== EXPECTED_ACCOUNT_ID) {
    console.error(
      `\n❌ Cette clé Stripe pointe vers le compte ${account.id}, pas ${EXPECTED_ACCOUNT_ID} ` +
        '(celui connecté dans Sentio → Settings → Integrations).\n' +
        '   Créer les clients ici ne servirait à rien : sync-stripe ne les verrait jamais. Abandon.\n',
    )
    process.exit(1)
  }
  console.log(`✅ Clé Stripe confirmée sur le compte attendu (${account.id})\n`)
}

// ─── Prix partagés (créés une fois, réutilisés par les 300 clients) ─────────
async function ensurePrices(): Promise<PriceSet> {
  console.log('📦 Création du produit et des 4 prix de test partagés...\n')
  const product = await withRetry(() =>
    stripe.products.create({
      name: '[TEST-SEG] Sentio segment validation plan',
      metadata: { sentio_seed: 'true' },
    }),
  )

  const [annualBase, annualUpgrade, monthlyBase, monthlyDowngrade] = await Promise.all([
    withRetry(() => stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: 299000, recurring: { interval: 'year' }, metadata: { sentio_seed: 'true' } })),
    withRetry(() => stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: 499000, recurring: { interval: 'year' }, metadata: { sentio_seed: 'true' } })),
    withRetry(() => stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: 29900, recurring: { interval: 'month' }, metadata: { sentio_seed: 'true' } })),
    withRetry(() => stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: 19900, recurring: { interval: 'month' }, metadata: { sentio_seed: 'true' } })),
  ])

  return {
    annualBase: annualBase.id,
    annualUpgrade: annualUpgrade.id,
    monthlyBase: monthlyBase.id,
    monthlyDowngrade: monthlyDowngrade.id,
  }
}

// Jeton de carte de test Stripe réutilisable tel quel sur plusieurs clients
// (documenté par Stripe pour ce cas d'usage — pas une vraie carte).
const TEST_CARD_PM = 'pm_card_visa'

async function attachWorkingTestCard(customerId: string): Promise<void> {
  const pm = await withRetry(() => stripe.paymentMethods.attach(TEST_CARD_PM, { customer: customerId }))
  await withRetry(() =>
    stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pm.id } }),
  )
}

async function createManualInvoice(
  customerId: string,
  amountCents: number,
  dueDateEpochSeconds: number,
  markUncollectible: boolean,
): Promise<void> {
  await withRetry(() =>
    stripe.invoiceItems.create({ customer: customerId, amount: amountCents, currency: 'usd', description: '[TEST-SEG] Sentio seed invoice' }),
  )
  const invoice = await withRetry(() =>
    stripe.invoices.create({ customer: customerId, collection_method: 'send_invoice', due_date: dueDateEpochSeconds, auto_advance: false }),
  )
  const finalized = await withRetry(() => stripe.invoices.finalizeInvoice(invoice.id))
  if (markUncollectible) {
    await withRetry(() => stripe.invoices.markUncollectible(finalized.id))
  }
}

// ─── Création d'un client par segment (phase 1) ─────────────────────────────
async function createOneCustomer(segment: SegmentKey, index: number, prices: PriceSet): Promise<SeedRecord> {
  const label = SEGMENTS.find((s) => s.key === segment)!.label
  const customer = await withRetry(() =>
    stripe.customers.create({
      name: `[TEST-SEG:${segment}] Account ${String(index + 1).padStart(3, '0')}`,
      metadata: { sentio_seed: 'true', sentio_seed_segment: segment },
      description: `[TEST] Segment validation cohort — target: ${label}`,
    }),
  )

  const nowSec = Math.floor(Date.now() / 1000)
  let subscriptionId: string | null = null
  let subscriptionItemId: string | null = null

  switch (segment) {
    case 'stables':
    case 'champions': {
      // Annuel + facture payée à temps + aucun signal de churn — la seule
      // différence entre les deux est la mutation de prix en phase 2
      // (Champions uniquement), qui génère le signal d'expansion requis.
      await attachWorkingTestCard(customer.id)
      const sub = await withRetry(() =>
        stripe.subscriptions.create({
          customer: customer.id,
          items: [{ price: prices.annualBase }],
          collection_method: 'charge_automatically',
          payment_behavior: 'error_if_incomplete',
        }),
      )
      subscriptionId = sub.id
      subscriptionItemId = sub.items.data[0].id
      break
    }

    case 'en_danger_critique': {
      // Mensuel (contribue "monthly + <6 mois" au churn risk dès la 1re sync)
      // + facture payée à temps. La contraction de prix en phase 2 ajoute le
      // signal "contraction MRR ≥20%/3mo" → total ≥50 pts → bande 'high'.
      await attachWorkingTestCard(customer.id)
      const sub = await withRetry(() =>
        stripe.subscriptions.create({
          customer: customer.id,
          items: [{ price: prices.monthlyBase }],
          collection_method: 'charge_automatically',
          payment_behavior: 'error_if_incomplete',
        }),
      )
      subscriptionId = sub.id
      subscriptionItemId = sub.items.data[0].id
      break
    }

    case 'a_risque_leger': {
      // Abonnement sain (mensuel) + 2 factures ponctuelles marquées
      // "uncollectible" avec échéance dans le FUTUR (pour ne jamais déclencher
      // hasOverdueInvoices, qui a priorité sur churnRiskBand dans la chaîne de
      // segmentation) → 2 échecs de paiement/90j = 25 pts = bande 'watch'.
      await attachWorkingTestCard(customer.id)
      const sub = await withRetry(() =>
        stripe.subscriptions.create({
          customer: customer.id,
          items: [{ price: prices.monthlyBase }],
          collection_method: 'charge_automatically',
          payment_behavior: 'error_if_incomplete',
        }),
      )
      subscriptionId = sub.id
      subscriptionItemId = sub.items.data[0].id
      const futureDueDate = nowSec + 5 * 86400
      await createManualInvoice(customer.id, 29900, futureDueDate, true)
      await createManualInvoice(customer.id, 29900, futureDueDate, true)
      break
    }

    case 'impayes': {
      // Abonnement actif + 1 facture ponctuelle avec échéance DANS LE PASSÉ,
      // statut 'open' (jamais payée) → hasOverdueInvoices=true, prioritaire
      // sur tout le reste de la chaîne de segmentation.
      await attachWorkingTestCard(customer.id)
      const sub = await withRetry(() =>
        stripe.subscriptions.create({
          customer: customer.id,
          items: [{ price: prices.monthlyBase }],
          collection_method: 'charge_automatically',
          payment_behavior: 'error_if_incomplete',
        }),
      )
      subscriptionId = sub.id
      subscriptionItemId = sub.items.data[0].id
      const pastDueDate = nowSec - 20 * 86400
      await createManualInvoice(customer.id, 29900, pastDueDate, false)
      break
    }

    case 'en_churn': {
      // Abonnement créé puis immédiatement annulé → mrr_cents=0 ET
      // subscriptionCanceled=true (les deux branches du critère en_churn).
      const sub = await withRetry(() =>
        stripe.subscriptions.create({
          customer: customer.id,
          items: [{ price: prices.monthlyBase }],
          collection_method: 'charge_automatically',
          payment_behavior: 'allow_incomplete',
        }),
      )
      await withRetry(() => stripe.subscriptions.cancel(sub.id))
      subscriptionId = sub.id
      subscriptionItemId = sub.items.data[0].id
      break
    }
  }

  return { segment, index, customerId: customer.id, subscriptionId, subscriptionItemId }
}

async function seedSegment(segment: SegmentKey, prices: PriceSet): Promise<SeedRecord[]> {
  const label = SEGMENTS.find((s) => s.key === segment)!.label
  const records: SeedRecord[] = []
  console.log(`\n🚀 ${label} (${segment}) — ${PER_SEGMENT} clients`)

  for (let start = 0; start < PER_SEGMENT; start += CONCURRENCY) {
    const chunkSize = Math.min(CONCURRENCY, PER_SEGMENT - start)
    const chunk = await Promise.all(
      Array.from({ length: chunkSize }, (_, k) => start + k).map(async (i) => {
        try {
          return await createOneCustomer(segment, i, prices)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`  ❌ [${segment} #${i + 1}] ${msg}`)
          return null
        }
      }),
    )
    for (const r of chunk) if (r) records.push(r)
    console.log(`  ✅ ${Math.min(start + chunkSize, PER_SEGMENT)}/${PER_SEGMENT}`)
    await sleep(INTER_CHUNK_DELAY_MS)
  }

  return records
}

// ─── Phase 1 : création ──────────────────────────────────────────────────────
async function runPhase1(): Promise<void> {
  await verifyConnectedAccount()
  const prices = await ensurePrices()

  const allRecords: SeedRecord[] = []
  for (const { key } of SEGMENTS) {
    const records = await seedSegment(key, prices)
    allRecords.push(...records)
  }

  const state: SeedState = { createdAt: new Date().toISOString(), prices, records: allRecords }
  saveState(state)

  console.log('\n─────────────────────────────────────────────────────────────')
  console.log(`✅ Phase 1 terminée : ${allRecords.length}/${PER_SEGMENT * SEGMENTS.length} clients créés`)
  for (const { key, label } of SEGMENTS) {
    const count = allRecords.filter((r) => r.segment === key).length
    console.log(`   ${label.padEnd(12)} (${key.padEnd(20)}) : ${count}/${PER_SEGMENT}`)
  }
  console.log('─────────────────────────────────────────────────────────────')
  console.log('\n💡 Prochaine étape :')
  console.log('   1. Déclenche une 1re sync Sentio : POST /sync-stripe avec { "organization_id": "<ton org>" }')
  console.log('      (ou "Rafraîchir les données" dans le dashboard Sentio)')
  console.log('   2. Une fois la sync terminée, relance ce script avec --phase=2')
  console.log('      pour appliquer la hausse de prix (Champions) et la baisse de prix (Critical).')
  console.log('   3. Déclenche une 2e sync Sentio — c\'est CETTE sync qui produira les mouvements')
  console.log('      MRR "expansion"/"contraction" nécessaires à ces deux segments.')
  console.log('   4. Lance /calculate-scores (ou attends le cron) pour recalculer segments + primary_segment.\n')
}

// ─── Phase 2 : mutation (Champions ↑ / Critical ↓) ─────────────────────────
async function mutatePrice(record: SeedRecord, newPriceId: string): Promise<void> {
  if (!record.subscriptionId || !record.subscriptionItemId) return
  await withRetry(() =>
    stripe.subscriptions.update(record.subscriptionId as string, {
      items: [{ id: record.subscriptionItemId as string, price: newPriceId }],
      proration_behavior: 'none',
    }),
  )
}

async function mutateCohort(records: SeedRecord[], newPriceId: string, label: string): Promise<void> {
  console.log(`\n🔧 ${label} — mise à jour de ${records.length} abonnements`)
  for (let start = 0; start < records.length; start += CONCURRENCY) {
    const chunk = records.slice(start, start + CONCURRENCY)
    await Promise.all(
      chunk.map(async (r) => {
        try {
          await mutatePrice(r, newPriceId)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`  ❌ [${r.segment} ${r.customerId}] ${msg}`)
        }
      }),
    )
    console.log(`  ✅ ${Math.min(start + CONCURRENCY, records.length)}/${records.length}`)
    await sleep(INTER_CHUNK_DELAY_MS)
  }
}

async function runPhase2(): Promise<void> {
  await verifyConnectedAccount()
  const state = loadState()

  const championsRecords = state.records.filter((r) => r.segment === 'champions')
  const criticalRecords = state.records.filter((r) => r.segment === 'en_danger_critique')

  if (championsRecords.length === 0 && criticalRecords.length === 0) {
    console.error('❌ Aucun enregistrement Champions/Critical dans l\'état de phase 1 — rien à faire.')
    process.exit(1)
  }

  await mutateCohort(championsRecords, state.prices.annualUpgrade, 'Champions (hausse de prix → signal expansion)')
  await mutateCohort(criticalRecords, state.prices.monthlyDowngrade, 'Critical (baisse de prix → signal contraction)')

  console.log('\n─────────────────────────────────────────────────────────────')
  console.log('✅ Phase 2 terminée.')
  console.log('─────────────────────────────────────────────────────────────')
  console.log('\n💡 Déclenche maintenant une 2e sync Sentio (POST /sync-stripe) puis')
  console.log('   /calculate-scores pour que les mouvements MRR "expansion"/"contraction"')
  console.log('   soient générés et que primary_segment reflète Champions/Critical.\n')
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────
const phaseArg = process.argv.find((a) => a.startsWith('--phase='))
const phase = phaseArg?.split('=')[1]

if (phase === '1') {
  runPhase1().catch((err) => {
    console.error('\n💥 Erreur fatale (phase 1) :', err instanceof Error ? err.message : err)
    process.exit(1)
  })
} else if (phase === '2') {
  runPhase2().catch((err) => {
    console.error('\n💥 Erreur fatale (phase 2) :', err instanceof Error ? err.message : err)
    process.exit(1)
  })
} else {
  console.error(
    '\nUsage :\n' +
      '  STRIPE_SECRET_KEY=sk_test_... npx tsx scripts/seed-segment-test-data.ts --phase=1\n' +
      '  STRIPE_SECRET_KEY=sk_test_... npx tsx scripts/seed-segment-test-data.ts --phase=2\n',
  )
  process.exit(1)
}
