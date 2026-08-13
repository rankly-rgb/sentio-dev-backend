/**
 * seed-insertion-check.ts
 * Seed minimal Stripe test-mode pour valider le chemin de liste standard de
 * `sync-stripe` (customers non attachés à un test clock).
 *
 * Utilitaire distinct de `seed-churn-validation.ts` — celui-ci produit des
 * customers/subscriptions permanents, SANS test clock, précisément pour être
 * visibles via `GET /v1/customers` / `GET /v1/subscriptions` standard (le
 * chemin que `sync-stripe` parcourt réellement). `seed-churn-validation.ts`
 * a l'objectif inverse (churn daté via test clock) et n'est pas réutilisable
 * ici : ses customers sont structurellement invisibles de ce même chemin
 * standard (confirmé par point de contrôle en lecture seule sur
 * acct_1U2VFWGUjO0RDfER — voir session de vérification).
 *
 * Catalogue idempotent séparé : le produit/les prix `sentio_insertion_check`
 * (voir `ensureProductAndPrices`) sont recherchés via `metadata.source` avant
 * toute création et réutilisés s'ils existent — jamais mélangés avec le
 * catalogue `sentio_churn_seed`. Les 3 clients, eux, sont créés à neuf à
 * chaque `--seed` (comme les test clocks du script churn) — `--cleanup` les
 * retire par `metadata.source`.
 *
 * Usage :
 *   STRIPE_SEED_KEY=sk_test_... SEED_EXPECTED_ACCOUNT_ID=acct_... \
 *     npx tsx scripts/seed-insertion-check.ts --seed
 *   STRIPE_SEED_KEY=sk_test_... SEED_EXPECTED_ACCOUNT_ID=acct_... \
 *     npx tsx scripts/seed-insertion-check.ts --cleanup
 *   npx tsx scripts/seed-insertion-check.ts --dry-run --seed
 *   npx tsx scripts/seed-insertion-check.ts --dry-run --cleanup
 *
 * Garde-fou de compte (SEED_EXPECTED_ACCOUNT_ID) : même logique que
 * `seed-churn-validation.ts` (`verifyExpectedAccount`) — compare le compte
 * réellement atteint par STRIPE_SEED_KEY à SEED_EXPECTED_ACCOUNT_ID, refuse
 * de créer/supprimer quoi que ce soit en cas d'absence ou de mismatch.
 *
 * Prérequis :
 *   - STRIPE_SEED_KEY : clé Stripe TEST-mode (sk_test_...) du compte dédié
 *     au seed — jamais STRIPE_SECRET_KEY (clé plateforme Sentio), jamais de
 *     valeur par défaut
 *   - SEED_EXPECTED_ACCOUNT_ID : acct_... du compte Stripe test-mode dédié,
 *     requis pour --seed et --cleanup (pas pour --dry-run)
 *
 * Procédure d'exécution complète (--dry-run mis à part, hors session) :
 *   1. npx tsx scripts/seed-insertion-check.ts --seed
 *   2. Vérifier : GET /v1/customers?limit=100 (sans test_clock) doit lister
 *      les 3 clients metadata.source=sentio_insertion_check
 *   3. Étape manuelle hors session : appeler l'Edge Function `sync-stripe`
 *      avec `organization_id` d'un org Sentio dont la clé Stripe pointe
 *      vers CE MÊME compte dédié
 *   4. npx tsx scripts/seed-insertion-check.ts --cleanup (supprime
 *      uniquement les 3 clients créés ici — le produit/les prix
 *      sentio_insertion_check sont volontairement conservés, réutilisés par
 *      le prochain --seed grâce à l'idempotence ci-dessus)
 */

import Stripe from 'stripe'

// ─── CONFIG ──────────────────────────────────────────────────────────────

const METADATA_SOURCE = 'sentio_insertion_check'
// Même version que seed-churn-validation.ts (scripts/seed-150-demo-accounts.ts:23) —
// aucune version canonique n'existe côté Edge Functions (audit Q4).
const API_VERSION = '2026-02-25.clover'

const PRICE_AMOUNTS_CENTS: { starter: number; growth: number; scale: number } = {
  starter: 4900,
  growth: 19900,
  scale: 59900,
}

// ─── HELPERS génériques ──────────────────────────────────────────────────

function log(message: string): void {
  const time = new Date().toISOString().split('T')[1].split('.')[0]
  console.log(`[${time}] ${message}`)
}

// ─── Garde-fous d'entrée (identiques à seed-churn-validation.ts) ─────────

function readSeedKey(): string {
  const key = process.env.STRIPE_SEED_KEY
  if (!key || !key.startsWith('sk_test')) {
    console.error(
      '\n❌ STRIPE_SEED_KEY absente ou ne commence pas par sk_test.\n' +
        '   Ce script ne lit JAMAIS STRIPE_SECRET_KEY (clé plateforme Sentio) ni aucune\n' +
        "   valeur par défaut — exporte une clé TEST-mode dédiée avant de lancer :\n" +
        '   export STRIPE_SEED_KEY=sk_test_...\n',
    )
    process.exit(1)
  }
  return key
}

function getStripeClient(): Stripe {
  return new Stripe(readSeedKey(), { apiVersion: API_VERSION })
}

/**
 * Garde-fou bloquant, appelé avant toute création/suppression d'objet
 * Stripe (--seed et --cleanup) — même logique que
 * `seed-churn-validation.ts` (`verifyExpectedAccount`), reprise à l'identique
 * pour éviter de seeder par erreur dans le compte Stripe test-mode partagé
 * (fallback global STRIPE_SECRET_KEY, voir sync-stripe/index.ts).
 */
async function verifyExpectedAccount(stripe: Stripe): Promise<void> {
  const expected = process.env.SEED_EXPECTED_ACCOUNT_ID
  if (!expected) {
    console.error(
      '\n❌ SEED_EXPECTED_ACCOUNT_ID absente.\n' +
        '   Ce garde-fou existe précisément pour empêcher ce script de seeder dans le\n' +
        "   compte Stripe test-mode partagé par les orgs dev sans stripe_api_key propre\n" +
        "   (fallback global STRIPE_SECRET_KEY, voir sync-stripe/index.ts). Exporte l'id\n" +
        "   acct_... du compte Stripe test-mode dédié à ce seed avant de lancer :\n" +
        '   export SEED_EXPECTED_ACCOUNT_ID=acct_...\n',
    )
    process.exit(1)
  }

  const account = await stripe.accounts.retrieve()
  if (account.id !== expected) {
    console.error(
      '\n❌ Compte Stripe inattendu.\n' +
        `   STRIPE_SEED_KEY pointe vers le compte ${account.id}, mais\n` +
        `   SEED_EXPECTED_ACCOUNT_ID vaut ${expected}.\n` +
        '   Aucun objet Stripe n\'a été créé — refus avant toute création, exactement\n' +
        '   pour éviter de seeder dans le mauvais compte test-mode.\n',
    )
    process.exit(1)
  }

  const label = [account.business_profile?.name, account.email].filter(Boolean).join(' / ')
  log(`✓ Compte Stripe confirmé : ${account.id}${label ? ` (${label})` : ''}`)
}

// ─── Produit / prix partagés ─────────────────────────────────────────────

interface SeedPrices {
  starter: string
  growth: string
  scale: string
}

const PRICE_TIER_KEYS: Array<keyof SeedPrices> = ['starter', 'growth', 'scale']

function isPriceTierKey(value: string | undefined): value is keyof SeedPrices {
  return value === 'starter' || value === 'growth' || value === 'scale'
}

/**
 * Recherche le produit sentio_insertion_check déjà créé par un run précédent.
 * `products.list()` (pas `products.search()`) délibérément — même raison que
 * `seed-churn-validation.ts` (`findExistingProduct`) : l'index de recherche
 * Stripe n'est qu'éventuellement cohérent, inadapté à un read-after-write
 * exécuté à chaque lancement de --seed. `list()` lit la source primaire.
 */
async function findExistingProduct(stripe: Stripe): Promise<Stripe.Product | null> {
  for await (const product of stripe.products.list({ limit: 100 })) {
    if (product.metadata.source === METADATA_SOURCE) return product
  }
  return null
}

async function findExistingPrices(stripe: Stripe, productId: string): Promise<Partial<SeedPrices>> {
  const found: Partial<SeedPrices> = {}
  for await (const price of stripe.prices.list({ product: productId, limit: 100 })) {
    const tier = price.metadata.tier
    if (isPriceTierKey(tier) && !found[tier]) {
      found[tier] = price.id
    }
  }
  return found
}

/**
 * Idempotent : réutilise le produit/les prix sentio_insertion_check s'ils
 * existent déjà (metadata.source), n'en crée que ce qui manque. Une relance
 * de --seed ne duplique donc jamais le catalogue — contrairement aux 3
 * clients (créés à neuf à chaque run, retirés par --cleanup via
 * metadata.source).
 */
async function ensureProductAndPrices(stripe: Stripe): Promise<SeedPrices> {
  let product = await findExistingProduct(stripe)
  if (product) {
    log(`  produit réutilisé : ${product.id} (metadata.source=${METADATA_SOURCE} déjà présent)`)
  } else {
    product = await stripe.products.create({
      name: 'Sentio Insertion Check Plan',
      metadata: { source: METADATA_SOURCE },
    })
    log(`  produit créé : ${product.id}`)
  }

  const existingPrices = await findExistingPrices(stripe, product.id)

  const tiers: Array<{ key: keyof SeedPrices; amountCents: number }> = PRICE_TIER_KEYS.map((key) => ({
    key,
    amountCents: PRICE_AMOUNTS_CENTS[key],
  }))

  const prices: Partial<SeedPrices> = {}
  for (const tier of tiers) {
    const existingId = existingPrices[tier.key]
    if (existingId) {
      prices[tier.key] = existingId
      log(`  prix réutilisé : ${tier.key} -> ${existingId}`)
      continue
    }
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: tier.amountCents,
      currency: 'usd',
      recurring: { interval: 'month' },
      metadata: { source: METADATA_SOURCE, tier: tier.key },
    })
    prices[tier.key] = price.id
    log(`  prix créé : ${tier.key} -> ${price.id} ($${(tier.amountCents / 100).toFixed(2)}/mo)`)
  }

  return prices as SeedPrices
}

// ─── Clients / subscriptions (SANS test clock) ────────────────────────────

interface SeededAccount {
  customerId: string
  subscriptionId: string
}

/**
 * Client ordinaire, volontairement SANS `test_clock` — c'est tout l'objet de
 * ce script : rester visible via le chemin de liste standard
 * (`GET /v1/customers`, `GET /v1/subscriptions`) que `sync-stripe` parcourt
 * réellement, contrairement aux customers de `seed-churn-validation.ts`.
 */
async function createCustomerAndSubscription(
  stripe: Stripe,
  priceId: string,
  tier: keyof SeedPrices,
  label: string,
): Promise<SeededAccount> {
  const customer = await stripe.customers.create({
    email: `${label}@seed.invalid`,
    metadata: { source: METADATA_SOURCE, tier },
  })

  const paymentMethod = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id })
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: paymentMethod.id },
  })

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: priceId }],
    metadata: { source: METADATA_SOURCE, tier },
  })

  log(`  client ${label} : customer=${customer.id} subscription=${subscription.id} (${subscription.status}, ${tier})`)
  return { customerId: customer.id, subscriptionId: subscription.id }
}

// ─── Seed ───────────────────────────────────────────────────────────────

async function runSeed(): Promise<void> {
  const stripe = getStripeClient()
  await verifyExpectedAccount(stripe)

  log('\n▶ Produit / prix partagés...')
  const prices = await ensureProductAndPrices(stripe)

  log('\n▶ 3 clients ordinaires (sans test clock, 1 par niveau)...')
  const accounts: SeededAccount[] = []
  accounts.push(await createCustomerAndSubscription(stripe, prices.starter, 'starter', `${METADATA_SOURCE}_starter`))
  accounts.push(await createCustomerAndSubscription(stripe, prices.growth, 'growth', `${METADATA_SOURCE}_growth`))
  accounts.push(await createCustomerAndSubscription(stripe, prices.scale, 'scale', `${METADATA_SOURCE}_scale`))

  log('\n──────────────────────────────────────────')
  log(`Seed terminé : ${accounts.length}/3 clients créés, chacun avec une subscription active.`)
  log(
    'Prochaine étape : GET /v1/customers?limit=100 (standard, sans test_clock) doit lister ces ' +
      `3 clients (metadata.source=${METADATA_SOURCE}). Puis, hors session, sync-stripe avec ` +
      "organization_id d'un org dont la clé Stripe pointe vers CE compte.",
  )
}

// ─── Cleanup ──────────────────────────────────────────────────────────────

/**
 * `customers.list()` paginé + filtre client par `metadata.source` — pas
 * `customers.search()`, même raison de cohérence immédiate que
 * `findExistingProduct` ci-dessus. Le compte cible est dédié à ce seed
 * (garde-fou SEED_EXPECTED_ACCOUNT_ID), le nombre de customers reste petit.
 */
async function findSeededCustomers(stripe: Stripe): Promise<Stripe.Customer[]> {
  const found: Stripe.Customer[] = []
  for await (const customer of stripe.customers.list({ limit: 100 })) {
    if (customer.metadata.source === METADATA_SOURCE) found.push(customer)
  }
  return found
}

async function runCleanup(): Promise<void> {
  const stripe = getStripeClient()
  await verifyExpectedAccount(stripe)

  log(`\n▶ Recherche des clients metadata.source=${METADATA_SOURCE} ...`)
  const customers = await findSeededCustomers(stripe)

  if (customers.length === 0) {
    log('Aucun client trouvé avec cette metadata — rien à nettoyer.')
    return
  }

  log(`\n${customers.length} client(s) à supprimer :`)
  for (const customer of customers) {
    log(`  ${customer.id} (${customer.email ?? 'sans email'})`)
  }

  log('\nAnnulation des subscriptions puis suppression des clients...')
  for (const customer of customers) {
    for await (const subscription of stripe.subscriptions.list({ customer: customer.id, limit: 100 })) {
      if (subscription.status !== 'canceled') {
        await stripe.subscriptions.cancel(subscription.id)
        log(`  ✓ subscription annulée : ${subscription.id} (customer=${customer.id})`)
      }
    }
    await stripe.customers.del(customer.id)
    log(`  ✓ client supprimé : ${customer.id}`)
  }

  log(
    '\nNote : le produit/les prix partagés ' +
      `(metadata.source=${METADATA_SOURCE}) créés par --seed sont volontairement conservés — ` +
      "ensureProductAndPrices() les réutilise au prochain --seed au lieu d'en créer de nouveaux " +
      "(idempotence). Ce script n'écrit jamais dans Supabase, donc --cleanup ne touche non plus " +
      "aucune donnée d'org/compte Sentio.",
  )
}

// ─── Dry-run ──────────────────────────────────────────────────────────────

function printDryRunPlan(seed: boolean, cleanup: boolean): void {
  console.log('DRY RUN — aucun appel API Stripe ne sera émis.\n')
  console.log(
    "Garde-fou de compte : IGNORÉ en dry-run (pas d'appel accounts.retrieve(), pas de clé requise).",
  )
  console.log('Si STRIPE_SEED_KEY / SEED_EXPECTED_ACCOUNT_ID sont définies, elles sont ignorées ici.\n')

  if (seed) {
    console.log('=== plan --seed ===')
    console.log(`1. Chercher un produit existant (metadata.source=${METADATA_SOURCE}) via products.list —`)
    console.log('   le réutiliser si trouvé, sinon créer "Sentio Insertion Check Plan"')
    console.log('2. Pour chaque prix (starter $49.00, growth $199.00, scale $599.00) : chercher un prix')
    console.log('   existant sur ce produit (metadata.tier=<niveau>) via prices.list — le réutiliser si')
    console.log('   trouvé, sinon le créer (mensuel usd). Idempotent : une relance ne duplique jamais')
    console.log('   le catalogue.')
    console.log('')
    console.log('3. Créer 3 clients ORDINAIRES (aucun test_clock) :')
    console.log('   - client starter : customers.create + paymentMethods.attach(pm_card_visa) +')
    console.log('     subscriptions.create sur le prix starter')
    console.log('   - client growth  : idem sur le prix growth')
    console.log('   - client scale   : idem sur le prix scale')
    console.log(`   Chaque client/subscription porte metadata.source=${METADATA_SOURCE}.`)
    console.log('')
    console.log('Total : 3 clients, 3 subscriptions actives, tous visibles via GET /v1/customers et')
    console.log('GET /v1/subscriptions standard (aucun test_clock). Zéro appel émis en --dry-run.')
  }

  if (cleanup) {
    console.log('\n=== plan --cleanup ===')
    console.log(`1. Lister les clients (customers.list paginé), filtrer par metadata.source=${METADATA_SOURCE}`)
    console.log('2. Pour chaque client trouvé : lister ses subscriptions, annuler celles encore actives')
    console.log('3. Supprimer chaque client trouvé (customers.del)')
    console.log('Le produit/les prix partagés ne sont jamais supprimés par --cleanup.')
    console.log('Zéro appel émis en --dry-run.')
  }

  if (!seed && !cleanup) {
    console.log('(ni --seed ni --cleanup fourni — rien à planifier ; combine --dry-run avec l\'un des deux)')
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
Usage:
  STRIPE_SEED_KEY=sk_test_... SEED_EXPECTED_ACCOUNT_ID=acct_... \\
    npx tsx scripts/seed-insertion-check.ts --seed
  STRIPE_SEED_KEY=sk_test_... SEED_EXPECTED_ACCOUNT_ID=acct_... \\
    npx tsx scripts/seed-insertion-check.ts --cleanup
  npx tsx scripts/seed-insertion-check.ts --dry-run --seed
  npx tsx scripts/seed-insertion-check.ts --dry-run --cleanup

Flags:
  --seed       Crée 3 clients ordinaires (sans test clock), chacun avec une
               subscription active sur un prix mensuel (starter/growth/scale)
  --cleanup    Supprime uniquement les clients portant metadata.source=${METADATA_SOURCE}
               (annule leurs subscriptions actives, puis supprime le client)
  --dry-run    Affiche le plan complet, émet zéro appel API. À combiner avec
               --seed et/ou --cleanup. Ne requiert ni STRIPE_SEED_KEY ni
               SEED_EXPECTED_ACCOUNT_ID.

Objectif : produire un dataset Stripe test-mode visible du chemin de liste
standard de sync-stripe (aucun test_clock), pour valider ce chemin
indépendamment des seeds test-clock (seed-churn-validation.ts). Voir la
docstring en tête de fichier pour la procédure complète.
`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const seed = args.includes('--seed')
  const cleanup = args.includes('--cleanup')
  const dryRun = args.includes('--dry-run')

  if (!seed && !cleanup && !dryRun) {
    printHelp()
    process.exit(0)
  }

  if (dryRun) {
    printDryRunPlan(seed, cleanup)
    if (!seed && !cleanup) printHelp()
    return
  }

  if (seed) await runSeed()
  if (cleanup) await runCleanup()
}

main().catch((err) => {
  console.error('\n💥 Erreur fatale :', err instanceof Error ? err.message : err)
  process.exit(1)
})
