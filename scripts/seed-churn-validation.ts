/**
 * seed-churn-validation.ts
 * Seed minimal Stripe test-mode pour débloquer la validation de PR #45
 * (correctif d'écriture `mrr_movements` — voir docs/CHANGELOG_STABILITY.md,
 * entrée "mrr_movements — upsert cassé depuis la création de la table").
 *
 * `mrr_movements` n'a encore jamais produit une seule ligne en conditions
 * réelles depuis ce correctif. Ce script crée un dataset Stripe test-mode
 * minimal via test clocks pour produire un vrai churn daté, observable par
 * `sync-stripe` puis par la tuile Churn Rate (`dashboard-api`).
 *
 * Scope délibérément restreint au churn : d'après l'audit préalable
 * (sync-stripe/index.ts:679-701), `churn` est le SEUL type de mouvement que
 * `sync-stripe` date correctement dans le passé (via `canceled_at`) — les
 * types `new`/`expansion`/`contraction` sont écrasés à la date du jour du
 * run, sauf s'ils sont captés en temps réel par `stripe-webhook`
 * (divergence documentée séparément, hors scope ici). Un dataset churn-only
 * évite de dépendre de cette divergence non résolue.
 *
 * Catalogue idempotent : le produit/les prix `sentio_churn_seed` (voir
 * `ensureProductAndPrices`) sont recherchés via `metadata.source` avant
 * toute création et réutilisés s'ils existent — relancer --seed plusieurs
 * fois ne duplique donc jamais le catalogue. Les test clocks, eux, sont
 * TOUJOURS créés à neuf à chaque run : ils sont volontairement éphémères
 * (voir --cleanup), la réutilisation n'aurait aucun sens pour eux.
 *
 * Usage :
 *   STRIPE_SEED_KEY=sk_test_... SEED_EXPECTED_ACCOUNT_ID=acct_... \
 *     npx tsx scripts/seed-churn-validation.ts --seed
 *   STRIPE_SEED_KEY=sk_test_... SEED_EXPECTED_ACCOUNT_ID=acct_... \
 *     npx tsx scripts/seed-churn-validation.ts --cleanup
 *   npx tsx scripts/seed-churn-validation.ts --dry-run --seed
 *   npx tsx scripts/seed-churn-validation.ts --dry-run --cleanup
 *
 * Garde-fou de compte (SEED_EXPECTED_ACCOUNT_ID) : 8 des 11 orgs dev Sentio
 * (les doublons `contactnsocialmediaonline`) n'ont pas de `stripe_api_key`
 * propre et retombent toutes sur le même fallback global `STRIPE_SECRET_KEY`
 * (sync-stripe/index.ts, filtre `orgsToSync`) — donc sur le même compte
 * Stripe test-mode réel. Ce garde-fou, sur le modèle de
 * `seed-segment-test-data.ts:56` (`EXPECTED_ACCOUNT_ID`), empêche de
 * seeder par erreur dans ce compte partagé : il compare le compte réellement
 * atteint par `STRIPE_SEED_KEY` à un `acct_...` attendu, et refuse de créer
 * quoi que ce soit en cas d'absence ou de mismatch.
 *
 * Prérequis :
 *   - npm install -D stripe tsx (si pas déjà installé — stripe@20.4.0 est
 *     déjà une dépendance du repo)
 *   - STRIPE_SEED_KEY : clé Stripe TEST-mode (sk_test_...) du compte dédié
 *     au seed — jamais STRIPE_SECRET_KEY (clé plateforme Sentio), jamais de
 *     valeur par défaut
 *   - SEED_EXPECTED_ACCOUNT_ID : acct_... du compte Stripe test-mode dédié,
 *     requis pour --seed et --cleanup (pas pour --dry-run)
 *
 * Procédure d'exécution complète (--dry-run mis à part, hors session) :
 *   1. npx tsx scripts/seed-churn-validation.ts --seed
 *   2. Attendre la fin du run (avances de test clock asynchrones — voir les
 *      logs en direct)
 *   3. Étape manuelle hors session : appeler l'Edge Function `sync-stripe`
 *      avec `organization_id` d'un org Sentio dont la clé Stripe pointe
 *      vers CE MÊME compte dédié (pas vers le fallback partagé)
 *   4. Observer `mrr_movements` (2 lignes `churn` dans les 30 derniers
 *      jours, 1 ligne `churn` hors fenêtre) puis la tuile Churn Rate
 *      (`dashboard-api` /portfolio-metrics)
 *   5. npx tsx scripts/seed-churn-validation.ts --cleanup (supprime
 *      uniquement les test clocks créés ici — le produit/les prix
 *      sentio_churn_seed sont volontairement conservés, réutilisés par le
 *      prochain --seed grâce à l'idempotence ci-dessus)
 *
 * Faits Stripe respectés (voir aussi le commentaire dans runSeed()) :
 *   - Stripe n'antidate aucun objet : `created` = maintenant à la création.
 *   - Test clocks : `frozen_time` place le point de départ dans le passé,
 *     n'avance ensuite que vers le futur. Max 3 customers / 3 subscriptions
 *     par horloge. Une avance ne peut dépasser 2 intervalles (ici mensuel)
 *     depuis le temps courant de l'horloge — d'où les avances en plusieurs
 *     étapes ci-dessous. Avance asynchrone : poller jusqu'à status='ready',
 *     gérer 'internal_failure'. Supprimer une horloge supprime ses
 *     customers et annule leurs subscriptions.
 *   - Avancer l'horloge à une date passée puis `subscriptions.cancel()`
 *     donne un `canceled_at` à cette date passée — le mécanisme qui produit
 *     le churn daté exploité ici.
 */

import Stripe from 'stripe'

// ─── CONFIG ──────────────────────────────────────────────────────────────

const CLOCK_PREFIX = 'sentio_churn_seed_'
const METADATA_SOURCE = 'sentio_churn_seed'
// Version la plus récente déjà pinnée dans ce repo (seed-150-demo-accounts.ts:23) —
// aucune version canonique n'existe côté Edge Functions (audit Q4).
const API_VERSION = '2026-02-25.clover'

const PRICE_AMOUNTS_CENTS: { starter: number; growth: number; scale: number } = {
  starter: 4900,
  growth: 19900,
  scale: 59900,
}

const SECONDS_PER_DAY = 24 * 60 * 60

// Offsets en jours avant "maintenant", choisis pour respecter la limite
// Stripe "avance <= 2 intervalles (mensuel) depuis le temps courant de
// l'horloge" à chaque appel `advance()` — chaque saut ci-dessous est <= 60
// jours (~2 mois). Voir runSeed() pour le détail des sauts par groupe.
const FROZEN_START_DAYS_AGO = 120 // ~4 mois — dénominateur/numérateur réels (audit Q3)
const MID_HOP_DAYS_AGO = 60 // ~2 mois — aussi la date du churn "témoin"
const WINDOW_CHURN_DAYS_AGO = 21 // ~3 semaines — dans la fenêtre 30j de calcChurnRate30d
const TODAY_DAYS_AGO = 0

const POLL_INTERVAL_MS = 3000
const MAX_POLL_ATTEMPTS = 60 // ~3 min max par avance

// ─── HELPERS génériques ──────────────────────────────────────────────────

function log(message: string): void {
  const time = new Date().toISOString().split('T')[1].split('.')[0]
  console.log(`[${time}] ${message}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().split('T')[0]
}

function daysAgoUnix(days: number, nowUnix: number): number {
  return nowUnix - days * SECONDS_PER_DAY
}

// ─── Garde-fous d'entrée ─────────────────────────────────────────────────

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
 * Stripe (--seed et --cleanup) — voir docstring du fichier. Compare le
 * compte réellement atteint par STRIPE_SEED_KEY à SEED_EXPECTED_ACCOUNT_ID.
 */
async function verifyExpectedAccount(stripe: Stripe): Promise<void> {
  const expected = process.env.SEED_EXPECTED_ACCOUNT_ID
  if (!expected) {
    console.error(
      '\n❌ SEED_EXPECTED_ACCOUNT_ID absente.\n' +
        '   Ce garde-fou existe précisément pour empêcher ce script de seeder dans le\n' +
        "   compte Stripe test-mode partagé par les 8 orgs dev 'contactnsocialmediaonline'\n" +
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
 * Recherche le produit sentio_churn_seed déjà créé par un run précédent.
 * `products.list()` (pas `products.search()`) délibérément : le SDK expose
 * bien `products.search()`/`prices.search()`, mais Stripe documente
 * explicitement leur index comme éventuellement cohérent ("Don't use search
 * in read-after-write flows where strict consistency is necessary... data
 * is searchable in less than a minute [normalement], up to an hour behind
 * during outages") — exactement le read-after-write qu'est cette
 * vérification d'idempotence à chaque lancement de --seed. `list()` lit la
 * source primaire, donc cohérence immédiate garantie, au prix d'une
 * pagination + filtre côté client plutôt qu'un filtre serveur — acceptable
 * ici : le compte cible est dédié à ce seed (garde-fou
 * SEED_EXPECTED_ACCOUNT_ID), son catalogue reste petit.
 */
async function findExistingProduct(stripe: Stripe): Promise<Stripe.Product | null> {
  for await (const product of stripe.products.list({ limit: 100 })) {
    if (product.metadata.source === METADATA_SOURCE) return product
  }
  return null
}

/**
 * Ré-associe les prix existants d'un produit réutilisé à leur niveau
 * (starter/growth/scale) via metadata.tier — posé à la création ci-dessous.
 * S'il existe plusieurs prix pour un même niveau (ex. reliquat d'un run
 * interrompu avant ce correctif d'idempotence), garde le premier rencontré
 * (ordre `list()` = created décroissant, donc le plus récent) plutôt que
 * d'en créer un de plus.
 */
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
 * Idempotent : réutilise le produit/les prix sentio_churn_seed s'ils
 * existent déjà (metadata.source), n'en crée que ce qui manque. Une
 * relance de --seed ne duplique donc jamais le catalogue — contrairement
 * aux test clocks (créés à neuf à chaque run, éphémères par construction,
 * nettoyés par --cleanup).
 */
async function ensureProductAndPrices(stripe: Stripe): Promise<SeedPrices> {
  let product = await findExistingProduct(stripe)
  if (product) {
    log(`  produit réutilisé : ${product.id} (metadata.source=${METADATA_SOURCE} déjà présent)`)
  } else {
    product = await stripe.products.create({
      name: 'Sentio Churn Seed Plan',
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

// ─── Test clocks ─────────────────────────────────────────────────────────

async function createClock(stripe: Stripe, name: string, frozenTimeUnix: number): Promise<Stripe.TestHelpers.TestClock> {
  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: frozenTimeUnix,
    name,
  })
  log(`  horloge créée : ${clock.id} (${name}) frozen_time=${isoDate(frozenTimeUnix)}`)
  return clock
}

async function advanceClockAndWait(stripe: Stripe, clockId: string, targetUnix: number): Promise<void> {
  log(`  avance horloge ${clockId} -> ${isoDate(targetUnix)} ...`)
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: targetUnix })

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId)
    if (clock.status === 'ready') {
      log(`  horloge ${clockId} prête à ${isoDate(clock.frozen_time)}`)
      return
    }
    if (clock.status === 'internal_failure') {
      throw new Error(`horloge ${clockId} : internal_failure en avançant vers ${isoDate(targetUnix)}`)
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`horloge ${clockId} : toujours pas 'ready' après ${MAX_POLL_ATTEMPTS} tentatives`)
}

// ─── Comptes / subscriptions ─────────────────────────────────────────────

interface SeededAccount {
  customerId: string
  subscriptionId: string
}

async function createCustomerAndSubscription(
  stripe: Stripe,
  clockId: string,
  priceId: string,
  label: string,
): Promise<SeededAccount> {
  const customer = await stripe.customers.create({
    email: `${label}@seed.invalid`,
    test_clock: clockId,
    metadata: { source: METADATA_SOURCE },
  })

  const paymentMethod = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id })
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: paymentMethod.id },
  })

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: priceId }],
    metadata: { source: METADATA_SOURCE },
  })

  log(`  compte ${label} : customer=${customer.id} subscription=${subscription.id}`)
  return { customerId: customer.id, subscriptionId: subscription.id }
}

async function cancelAndLog(stripe: Stripe, subscriptionId: string, label: string): Promise<void> {
  const canceled = await stripe.subscriptions.cancel(subscriptionId)
  const canceledAt = canceled.canceled_at
  log(`  annulé ${label} : subscription=${subscriptionId} canceled_at=${canceledAt ? isoDate(canceledAt) : 'null'}`)
}

// ─── Groupes d'horloges (seed) ───────────────────────────────────────────

interface ClockGroupResult {
  clockName: string
  ok: boolean
  error?: string
}

/**
 * Dénominateur — comptes actifs jamais annulés. Créés à T-120j, avancés en
 * deux sauts <=60j (T-120 -> T-60 -> aujourd'hui) pour rester dans la limite
 * "<=2 intervalles mensuels par avance" tout en portant un MRR à jour au
 * moment où sync-stripe lira le compte.
 */
async function runDenominatorGroup(
  stripe: Stripe,
  groupIndex: number,
  priceIds: string[],
  offsets: { start: number; mid: number; today: number },
): Promise<ClockGroupResult> {
  const clockName = `${CLOCK_PREFIX}denom_${groupIndex}`
  try {
    const clock = await createClock(stripe, clockName, offsets.start)
    for (let i = 0; i < priceIds.length; i++) {
      await createCustomerAndSubscription(stripe, clock.id, priceIds[i], `${clockName}_acct${i + 1}`)
    }
    await advanceClockAndWait(stripe, clock.id, offsets.mid)
    await advanceClockAndWait(stripe, clock.id, offsets.today)
    return { clockName, ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`  ✗ groupe ${clockName} en échec : ${message}`)
    return { clockName, ok: false, error: message }
  }
}

/**
 * Numérateur — 2 churns dans la fenêtre 30j de calcChurnRate30d. Avance en
 * deux sauts (T-120 -> T-60 -> T-21), annulation des deux subscriptions à
 * T-21 (canceled_at ~3 semaines, donc bien à l'intérieur des 30 derniers
 * jours — audit Q2).
 */
async function runWindowChurnGroup(
  stripe: Stripe,
  priceIds: string[],
  offsets: { start: number; mid: number; windowChurn: number },
): Promise<ClockGroupResult> {
  const clockName = `${CLOCK_PREFIX}window_churn`
  try {
    const clock = await createClock(stripe, clockName, offsets.start)
    const accounts: SeededAccount[] = []
    for (let i = 0; i < priceIds.length; i++) {
      accounts.push(await createCustomerAndSubscription(stripe, clock.id, priceIds[i], `${clockName}_acct${i + 1}`))
    }
    await advanceClockAndWait(stripe, clock.id, offsets.mid)
    await advanceClockAndWait(stripe, clock.id, offsets.windowChurn)
    for (let i = 0; i < accounts.length; i++) {
      await cancelAndLog(stripe, accounts[i].subscriptionId, `${clockName}_acct${i + 1}`)
    }
    return { clockName, ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`  ✗ groupe ${clockName} en échec : ${message}`)
    return { clockName, ok: false, error: message }
  }
}

/**
 * Témoin — 1 churn HORS fenêtre 30j (canceled_at ~T-60j). Test discriminant
 * (audit Q2) : `dashboard-api/index.ts:442` filtre `movement_date >=
 * (aujourd'hui - 30j)`, et ce compte n'est déjà plus dans le MRR courant —
 * il ne doit apparaître ni au numérateur ni au dénominateur du taux 30j.
 */
async function runControlChurnGroup(
  stripe: Stripe,
  priceId: string,
  offsets: { start: number; mid: number },
): Promise<ClockGroupResult> {
  const clockName = `${CLOCK_PREFIX}control_churn`
  try {
    const clock = await createClock(stripe, clockName, offsets.start)
    const account = await createCustomerAndSubscription(stripe, clock.id, priceId, `${clockName}_acct1`)
    await advanceClockAndWait(stripe, clock.id, offsets.mid)
    await cancelAndLog(stripe, account.subscriptionId, `${clockName}_acct1`)
    return { clockName, ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`  ✗ groupe ${clockName} en échec : ${message}`)
    return { clockName, ok: false, error: message }
  }
}

async function runSeed(): Promise<void> {
  const stripe = getStripeClient()
  await verifyExpectedAccount(stripe)

  const nowUnix = Math.floor(Date.now() / 1000)
  const offsets = {
    start: daysAgoUnix(FROZEN_START_DAYS_AGO, nowUnix),
    mid: daysAgoUnix(MID_HOP_DAYS_AGO, nowUnix),
    windowChurn: daysAgoUnix(WINDOW_CHURN_DAYS_AGO, nowUnix),
    today: daysAgoUnix(TODAY_DAYS_AGO, nowUnix),
  }

  log('\n▶ Produit / prix partagés...')
  const prices = await ensureProductAndPrices(stripe)

  log('\n▶ Groupe dénominateur 1/2 (3 comptes actifs, jamais annulés)...')
  const d1 = await runDenominatorGroup(stripe, 1, [prices.starter, prices.starter, prices.growth], offsets)

  log('\n▶ Groupe dénominateur 2/2 (2 comptes actifs, jamais annulés)...')
  const d2 = await runDenominatorGroup(stripe, 2, [prices.growth, prices.scale], offsets)

  log('\n▶ Groupe churn fenêtre 30j (2 comptes, canceled_at ~T-21j)...')
  const w1 = await runWindowChurnGroup(stripe, [prices.growth, prices.starter], offsets)

  log('\n▶ Groupe témoin hors fenêtre (1 compte, canceled_at ~T-60j)...')
  const c1 = await runControlChurnGroup(stripe, prices.scale, offsets)

  const results = [d1, d2, w1, c1]
  const failed = results.filter((r) => !r.ok)
  log('\n──────────────────────────────────────────')
  log(`Seed terminé : ${results.length - failed.length}/${results.length} groupes d'horloge réussis.`)
  if (failed.length > 0) {
    log(`Groupes en échec : ${failed.map((f) => f.clockName).join(', ')} — voir erreurs ci-dessus.`)
  }
  log(
    'Prochaine étape (hors session) : lancer sync-stripe avec organization_id d\'un org ' +
      'dont la clé Stripe pointe vers CE compte, puis observer mrr_movements et la tuile Churn Rate.',
  )
}

// ─── Cleanup ──────────────────────────────────────────────────────────────

async function runCleanup(): Promise<void> {
  const stripe = getStripeClient()
  await verifyExpectedAccount(stripe)

  log(`\n▶ Recherche des test clocks préfixés "${CLOCK_PREFIX}" ...`)
  const clocks: Stripe.TestHelpers.TestClock[] = []
  for await (const clock of stripe.testHelpers.testClocks.list({ limit: 100 })) {
    if (clock.name?.startsWith(CLOCK_PREFIX)) clocks.push(clock)
  }

  if (clocks.length === 0) {
    log('Aucune horloge trouvée avec ce préfixe — rien à nettoyer.')
    return
  }

  log(`\n${clocks.length} horloge(s) à supprimer :`)
  let totalCustomers = 0
  let totalSubscriptions = 0
  for (const clock of clocks) {
    const customers: Stripe.Customer[] = []
    for await (const customer of stripe.customers.list({ test_clock: clock.id, limit: 100 })) {
      customers.push(customer)
    }
    let subscriptionCount = 0
    for (const customer of customers) {
      for await (const _subscription of stripe.subscriptions.list({ customer: customer.id, limit: 100 })) {
        subscriptionCount += 1
      }
    }
    totalCustomers += customers.length
    totalSubscriptions += subscriptionCount
    log(`  ${clock.id} (${clock.name}) — ${customers.length} customer(s), ${subscriptionCount} subscription(s)`)
  }
  log(
    `\nTotal : ${clocks.length} horloge(s), ${totalCustomers} customer(s), ` +
      `${totalSubscriptions} subscription(s) vont être supprimé(e)s.`,
  )

  log('Suppression des test clocks (cascade : customers supprimés, subscriptions annulées)...')
  for (const clock of clocks) {
    await stripe.testHelpers.testClocks.del(clock.id)
    log(`  ✓ supprimée ${clock.id} (${clock.name})`)
  }

  log(
    '\nNote : ceci ne supprime que les objets attachés à ces test clocks. Le produit/les prix ' +
      `partagés (metadata.source=${METADATA_SOURCE}) créés par --seed sont volontairement ` +
      "conservés — ensureProductAndPrices() les réutilise au prochain --seed au lieu d'en créer " +
      "de nouveaux (idempotence). Ce script n'écrit jamais dans Supabase, donc --cleanup ne touche " +
      "non plus aucune donnée d'org/compte Sentio.",
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
    console.log('   le réutiliser si trouvé, sinon créer "Sentio Churn Seed Plan"')
    console.log('2. Pour chaque prix (starter $49.00, growth $199.00, scale $599.00) : chercher un prix')
    console.log('   existant sur ce produit (metadata.tier=<niveau>) via prices.list — le réutiliser si')
    console.log('   trouvé, sinon le créer (mensuel usd). Idempotent : une relance ne duplique jamais')
    console.log('   le catalogue — seuls les test clocks ci-dessous sont créés à neuf à chaque run.')
    console.log('')
    console.log(`3. Groupe dénominateur 1 — horloge "${CLOCK_PREFIX}denom_1", frozen_time=T-${FROZEN_START_DAYS_AGO}j`)
    console.log('   - créer 3 customers+subscriptions (starter, starter, growth)')
    console.log(`   - avancer l'horloge à T-${MID_HOP_DAYS_AGO}j puis à aujourd'hui — jamais annulés`)
    console.log('')
    console.log(`4. Groupe dénominateur 2 — horloge "${CLOCK_PREFIX}denom_2", frozen_time=T-${FROZEN_START_DAYS_AGO}j`)
    console.log('   - créer 2 customers+subscriptions (growth, scale)')
    console.log(`   - avancer l'horloge à T-${MID_HOP_DAYS_AGO}j puis à aujourd'hui — jamais annulés`)
    console.log('')
    console.log(`5. Groupe churn fenêtre 30j — horloge "${CLOCK_PREFIX}window_churn", frozen_time=T-${FROZEN_START_DAYS_AGO}j`)
    console.log('   - créer 2 customers+subscriptions (growth, starter)')
    console.log(`   - avancer l'horloge à T-${MID_HOP_DAYS_AGO}j puis à T-${WINDOW_CHURN_DAYS_AGO}j`)
    console.log(`   - annuler les deux subscriptions à T-${WINDOW_CHURN_DAYS_AGO}j (dans la fenêtre 30j)`)
    console.log('')
    console.log(`6. Groupe témoin hors fenêtre — horloge "${CLOCK_PREFIX}control_churn", frozen_time=T-${FROZEN_START_DAYS_AGO}j`)
    console.log('   - créer 1 customer+subscription (scale)')
    console.log(`   - avancer l'horloge à T-${MID_HOP_DAYS_AGO}j`)
    console.log(`   - annuler la subscription à T-${MID_HOP_DAYS_AGO}j (HORS fenêtre 30j, test discriminant)`)
    console.log('')
    console.log('Total : 4 test clocks, 8 customers, 8 subscriptions, 2 annulations dans la fenêtre')
    console.log('30j, 1 annulation hors fenêtre. Zéro appel émis en --dry-run.')
  }

  if (cleanup) {
    console.log('\n=== plan --cleanup ===')
    console.log(`1. Lister les test clocks, filtrer par préfixe de nom "${CLOCK_PREFIX}"`)
    console.log('2. Pour chaque horloge trouvée : lister les customers attachés (filtre test_clock)')
    console.log('   et leurs subscriptions, afficher les décomptes')
    console.log('3. Supprimer chaque horloge trouvée (cascade : customers supprimés, subs annulées)')
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
    npx tsx scripts/seed-churn-validation.ts --seed
  STRIPE_SEED_KEY=sk_test_... SEED_EXPECTED_ACCOUNT_ID=acct_... \\
    npx tsx scripts/seed-churn-validation.ts --cleanup
  npx tsx scripts/seed-churn-validation.ts --dry-run --seed
  npx tsx scripts/seed-churn-validation.ts --dry-run --cleanup

Flags:
  --seed       Crée le dataset de validation churn (8 comptes sur 4 test clocks)
  --cleanup    Supprime uniquement les test clocks préfixés "${CLOCK_PREFIX}"
               (et leurs customers/subscriptions attachés, via la cascade Stripe)
  --dry-run    Affiche le plan complet, émet zéro appel API. À combiner avec
               --seed et/ou --cleanup. Ne requiert ni STRIPE_SEED_KEY ni
               SEED_EXPECTED_ACCOUNT_ID.

Objectif : débloquer la validation de PR #45 (écriture mrr_movements) en
produisant un vrai churn daté observable par sync-stripe puis par la tuile
Churn Rate. Voir la docstring en tête de fichier pour la procédure complète
et le rôle du garde-fou de compte.
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
