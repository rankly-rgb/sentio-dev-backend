/**
 * seed-stripe-customers.ts
 * Crée 30 clients Stripe de test avec des profils variés.
 *
 * Usage :
 *   npx tsx scripts/seed-stripe-customers.ts
 *
 * Prérequis :
 *   - Renseigner STRIPE_SECRET_KEY ci-dessous (ou variable d'env)
 *   - npm install -D stripe tsx  (si pas déjà installé)
 */

import Stripe from "stripe";

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const STRIPE_SECRET_KEY =
  process.env.STRIPE_SECRET_KEY || "sk_test_REMPLACER_PAR_TA_CLE";

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// ─── DONNÉES DE RÉFÉRENCE ────────────────────────────────────────────────────

const PLANS = [
  { name: "Free",       price_monthly: 0,     label: "free" },
  { name: "Starter",    price_monthly: 49,    label: "starter" },
  { name: "Pro",        price_monthly: 149,   label: "pro" },
  { name: "Business",   price_monthly: 399,   label: "business" },
  { name: "Enterprise", price_monthly: 999,   label: "enterprise" },
];

const INDUSTRIES = [
  "SaaS B2B", "E-commerce", "Fintech", "EdTech", "Santé / Medtech",
  "Marketplace", "Logistique", "RH / HRTech", "Cybersécurité", "Immobilier",
];

const COUNTRIES = ["FR", "DE", "GB", "US", "ES", "NL", "BE", "CA", "CH", "IT"];

const COMPANY_SIZES = ["1-10", "11-50", "51-200", "201-500", "500+"];

// 30 clients avec profils intentionnellement variés
const CUSTOMERS: Array<{
  name: string;
  email: string;
  industry: string;
  country: string;
  company_size: string;
  plan: string;
  mrr: number;
  churn_risk: "low" | "medium" | "high";
  payment_behavior: "on_time" | "late" | "failed_once" | "churned";
  arr: number;
  seats: number;
  notes: string;
}> = [
  // ── ENTERPRISE (MRR élevé, risque faible) ───────────────────────────────
  {
    name: "Nexora Systems",
    email: "billing@nexora-systems.com",
    industry: "SaaS B2B",
    country: "FR",
    company_size: "500+",
    plan: "enterprise",
    mrr: 2490,
    churn_risk: "low",
    payment_behavior: "on_time",
    arr: 29880,
    seats: 120,
    notes: "Client flagship, contrat annuel signé, NPS 9/10",
  },
  {
    name: "Velox Finance",
    email: "accounts@veloxfinance.io",
    industry: "Fintech",
    country: "DE",
    company_size: "201-500",
    plan: "enterprise",
    mrr: 1980,
    churn_risk: "low",
    payment_behavior: "on_time",
    arr: 23760,
    seats: 85,
    notes: "Renouvellement automatique, expansion prévue Q2",
  },
  {
    name: "Meridian Health",
    email: "finance@meridian-health.eu",
    industry: "Santé / Medtech",
    country: "GB",
    company_size: "500+",
    plan: "enterprise",
    mrr: 3200,
    churn_risk: "low",
    payment_behavior: "on_time",
    arr: 38400,
    seats: 200,
    notes: "Conformité GDPR stricte, CSM dédié requis",
  },
  {
    name: "Lumenark Education",
    email: "billing@lumenark.edu",
    industry: "EdTech",
    country: "CA",
    company_size: "201-500",
    plan: "enterprise",
    mrr: 1490,
    churn_risk: "low",
    payment_behavior: "on_time",
    arr: 17880,
    seats: 60,
    notes: "Contrat 2 ans, formation en cours",
  },

  // ── BUSINESS (MRR moyen-haut) ─────────────────────────────────────────
  {
    name: "Orbitale SAS",
    email: "comptabilite@orbitale.fr",
    industry: "Marketplace",
    country: "FR",
    company_size: "51-200",
    plan: "business",
    mrr: 798,
    churn_risk: "low",
    payment_behavior: "on_time",
    arr: 9576,
    seats: 25,
    notes: "Upsell possible vers Enterprise en Q3",
  },
  {
    name: "Cargoway Logistics",
    email: "ops@cargoway.de",
    industry: "Logistique",
    country: "DE",
    company_size: "51-200",
    plan: "business",
    mrr: 399,
    churn_risk: "medium",
    payment_behavior: "late",
    arr: 4788,
    seats: 18,
    notes: "Paiement souvent en retard de 5-10 jours",
  },
  {
    name: "Recrutix HR",
    email: "admin@recrutix.io",
    industry: "RH / HRTech",
    country: "BE",
    company_size: "11-50",
    plan: "business",
    mrr: 399,
    churn_risk: "medium",
    payment_behavior: "on_time",
    arr: 4788,
    seats: 12,
    notes: "Utilisation API intensive, surveiller les quotas",
  },
  {
    name: "Shieldwave Security",
    email: "finance@shieldwave.io",
    industry: "Cybersécurité",
    country: "US",
    company_size: "11-50",
    plan: "business",
    mrr: 399,
    churn_risk: "low",
    payment_behavior: "on_time",
    arr: 4788,
    seats: 10,
    notes: "Croissance rapide, potentiel Enterprise",
  },
  {
    name: "Proptech Immo",
    email: "direction@proptech-immo.fr",
    industry: "Immobilier",
    country: "FR",
    company_size: "11-50",
    plan: "business",
    mrr: 399,
    churn_risk: "high",
    payment_behavior: "failed_once",
    arr: 4788,
    seats: 8,
    notes: "Paiement échoué en janvier, relancé manuellement",
  },

  // ── PRO (MRR intermédiaire) ───────────────────────────────────────────
  {
    name: "Datastride Analytics",
    email: "billing@datastride.io",
    industry: "SaaS B2B",
    country: "NL",
    company_size: "11-50",
    plan: "pro",
    mrr: 298,
    churn_risk: "low",
    payment_behavior: "on_time",
    arr: 3576,
    seats: 6,
    notes: "Champion interne très actif, potentiel referral",
  },
  {
    name: "Caravel Commerce",
    email: "ops@caravelcommerce.eu",
    industry: "E-commerce",
    country: "ES",
    company_size: "11-50",
    plan: "pro",
    mrr: 149,
    churn_risk: "medium",
    payment_behavior: "on_time",
    arr: 1788,
    seats: 4,
    notes: "Saisonnalité forte (Noël/été), watch MRR chute août",
  },
  {
    name: "Pulse Medtech",
    email: "admin@pulse-medtech.ch",
    industry: "Santé / Medtech",
    country: "CH",
    company_size: "1-10",
    plan: "pro",
    mrr: 298,
    churn_risk: "low",
    payment_behavior: "on_time",
    arr: 3576,
    seats: 3,
    notes: "Startup en série A, expansion prévue",
  },
  {
    name: "Edunova Labs",
    email: "contact@edunova-labs.fr",
    industry: "EdTech",
    country: "FR",
    company_size: "1-10",
    plan: "pro",
    mrr: 149,
    churn_risk: "high",
    payment_behavior: "late",
    arr: 1788,
    seats: 2,
    notes: "Login < 1x/semaine, risque churn élevé",
  },
  {
    name: "Finspark Technologies",
    email: "billing@finspark.io",
    industry: "Fintech",
    country: "IT",
    company_size: "1-10",
    plan: "pro",
    mrr: 149,
    churn_risk: "medium",
    payment_behavior: "on_time",
    arr: 1788,
    seats: 3,
    notes: "En attente validation réglementaire",
  },
  {
    name: "Wavemarket",
    email: "hello@wavemarket.fr",
    industry: "Marketplace",
    country: "FR",
    company_size: "11-50",
    plan: "pro",
    mrr: 298,
    churn_risk: "low",
    payment_behavior: "on_time",
    arr: 3576,
    seats: 7,
    notes: "Levée de fonds récente, budget validé",
  },
  {
    name: "Traffiq Agency",
    email: "admin@traffiq-agency.com",
    industry: "SaaS B2B",
    country: "GB",
    company_size: "11-50",
    plan: "pro",
    mrr: 149,
    churn_risk: "high",
    payment_behavior: "failed_once",
    arr: 1788,
    seats: 2,
    notes: "Carte expirée en déc, mise à jour en attente",
  },

  // ── STARTER (MRR faible) ──────────────────────────────────────────────
  {
    name: "Greenbyte Energy",
    email: "billing@greenbyte.energy",
    industry: "SaaS B2B",
    country: "FR",
    company_size: "1-10",
    plan: "starter",
    mrr: 49,
    churn_risk: "low",
    payment_behavior: "on_time",
    arr: 588,
    seats: 1,
    notes: "Startup early-stage, fidèle depuis 18 mois",
  },
  {
    name: "Nomado Travel",
    email: "finance@nomado-travel.eu",
    industry: "Marketplace",
    country: "ES",
    company_size: "1-10",
    plan: "starter",
    mrr: 49,
    churn_risk: "medium",
    payment_behavior: "on_time",
    arr: 588,
    seats: 2,
    notes: "Croissance lente, évalue les concurrents",
  },
  {
    name: "Koda Dev Studio",
    email: "hello@koda.dev",
    industry: "SaaS B2B",
    country: "BE",
    company_size: "1-10",
    plan: "starter",
    mrr: 49,
    churn_risk: "medium",
    payment_behavior: "late",
    arr: 588,
    seats: 1,
    notes: "Petite agence dev, paiement souvent tardif",
  },
  {
    name: "Shopflux E-com",
    email: "ops@shopflux.io",
    industry: "E-commerce",
    country: "FR",
    company_size: "1-10",
    plan: "starter",
    mrr: 49,
    churn_risk: "high",
    payment_behavior: "failed_once",
    arr: 588,
    seats: 1,
    notes: "Faible engagement, pas connecté depuis 3 semaines",
  },
  {
    name: "Luminos Conseil",
    email: "contact@luminos-conseil.fr",
    industry: "RH / HRTech",
    country: "FR",
    company_size: "1-10",
    plan: "starter",
    mrr: 49,
    churn_risk: "medium",
    payment_behavior: "on_time",
    arr: 588,
    seats: 2,
    notes: "Cabinet de conseil, usage modéré",
  },
  {
    name: "Terrabit Immo",
    email: "admin@terrabit-immo.fr",
    industry: "Immobilier",
    country: "FR",
    company_size: "1-10",
    plan: "starter",
    mrr: 49,
    churn_risk: "low",
    payment_behavior: "on_time",
    arr: 588,
    seats: 1,
    notes: "Agent immobilier indépendant, très satisfait",
  },
  {
    name: "Pixelcraft Agency",
    email: "billing@pixelcraft-agency.com",
    industry: "SaaS B2B",
    country: "BE",
    company_size: "1-10",
    plan: "starter",
    mrr: 49,
    churn_risk: "high",
    payment_behavior: "late",
    arr: 588,
    seats: 1,
    notes: "Usage quasi nul, candidat churning prochain mois",
  },

  // ── FREE / TRIAL (MRR = 0) ────────────────────────────────────────────
  {
    name: "Betaforge Labs",
    email: "founders@betaforge.io",
    industry: "SaaS B2B",
    country: "FR",
    company_size: "1-10",
    plan: "free",
    mrr: 0,
    churn_risk: "medium",
    payment_behavior: "on_time",
    arr: 0,
    seats: 1,
    notes: "Trial actif, démo planifiée la semaine prochaine",
  },
  {
    name: "Claraview Analytics",
    email: "trial@claraview.ai",
    industry: "SaaS B2B",
    country: "US",
    company_size: "1-10",
    plan: "free",
    mrr: 0,
    churn_risk: "low",
    payment_behavior: "on_time",
    arr: 0,
    seats: 2,
    notes: "Très actif en trial, conversion très probable",
  },
  {
    name: "Mobitrack Solutions",
    email: "contact@mobitrack.fr",
    industry: "Logistique",
    country: "FR",
    company_size: "1-10",
    plan: "free",
    mrr: 0,
    churn_risk: "high",
    payment_behavior: "on_time",
    arr: 0,
    seats: 1,
    notes: "Trial inscrit il y a 25 jours, aucune action",
  },
  {
    name: "Arclight Media",
    email: "billing@arclight-media.fr",
    industry: "Marketplace",
    country: "FR",
    company_size: "1-10",
    plan: "free",
    mrr: 0,
    churn_risk: "medium",
    payment_behavior: "on_time",
    arr: 0,
    seats: 1,
    notes: "En évaluation vs concurrent direct",
  },
  // ── CHURNED (annulation récente) ─────────────────────────────────────
  {
    name: "Axionex Corp",
    email: "ex-billing@axionex.com",
    industry: "Fintech",
    country: "US",
    company_size: "11-50",
    plan: "pro",
    mrr: 0,
    churn_risk: "high",
    payment_behavior: "churned",
    arr: 0,
    seats: 0,
    notes: "Churné en janvier, raison : budget coupé",
  },
  {
    name: "Greystone Consulting",
    email: "old@greystone-consulting.eu",
    industry: "RH / HRTech",
    country: "DE",
    company_size: "11-50",
    plan: "starter",
    mrr: 0,
    churn_risk: "high",
    payment_behavior: "churned",
    arr: 0,
    seats: 0,
    notes: "Churné en février, concurrent moins cher choisi",
  },
];

// ─── UTILITAIRES ─────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function planForLabel(label: string) {
  return PLANS.find((p) => p.label === label) ?? PLANS[0];
}

// ─── CRÉATION DES CLIENTS ────────────────────────────────────────────────────

async function createCustomers() {
  console.log(`\n🚀 Création de ${CUSTOMERS.length} clients Stripe de test...\n`);

  const results: { name: string; id: string; status: "ok" | "error" }[] = [];

  for (let i = 0; i < CUSTOMERS.length; i++) {
    const c = CUSTOMERS[i];
    const plan = planForLabel(c.plan);

    try {
      const customer = await stripe.customers.create({
        name: c.name,
        email: c.email,
        metadata: {
          // Sentio-specific metadata — sera lu par la Edge Function sync-stripe
          industry: c.industry,
          company_size: c.company_size,
          plan: c.plan,
          mrr_cents: String(c.mrr * 100),
          arr_cents: String(c.arr * 100),
          churn_risk: c.churn_risk,
          payment_behavior: c.payment_behavior,
          seats: String(c.seats),
          notes: c.notes,
          sentio_test_customer: "true",
        },
        address: {
          country: c.country,
        },
        description: `[TEST] ${c.industry} — Plan ${plan.name} — ${c.churn_risk} churn risk`,
        preferred_locales:
          c.country === "FR" || c.country === "BE"
            ? ["fr-FR"]
            : c.country === "DE"
            ? ["de-DE"]
            : c.country === "ES"
            ? ["es-ES"]
            : ["en-US"],
      });

      console.log(
        `  ✅ [${String(i + 1).padStart(2, "0")}/30] ${c.name.padEnd(28)} → ${customer.id}  (${c.plan}, MRR ${c.mrr}€, risque ${c.churn_risk})`
      );

      results.push({ name: c.name, id: customer.id, status: "ok" });

      // Respecter le rate-limit Stripe (max ~100 req/s en test)
      await sleep(120);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ [${String(i + 1).padStart(2, "0")}/30] ${c.name} → ERREUR: ${msg}`);
      results.push({ name: c.name, id: "", status: "error" });
    }
  }

  // ─── Résumé ──────────────────────────────────────────────────────────────
  const ok = results.filter((r) => r.status === "ok").length;
  const ko = results.filter((r) => r.status === "error").length;

  console.log("\n─────────────────────────────────────────────────────────────");
  console.log(`✅ ${ok} client(s) créé(s) avec succès`);
  if (ko > 0) console.log(`❌ ${ko} erreur(s)`);
  console.log("─────────────────────────────────────────────────────────────\n");

  console.log("IDs créés :");
  results
    .filter((r) => r.status === "ok")
    .forEach((r) => console.log(`  ${r.id}  ← ${r.name}`));

  console.log(
    "\n💡 Lance maintenant une sync Stripe depuis le Dashboard Sentio"
  );
  console.log(
    "   ou POST /sync-stripe avec sync_type: 'full_sync' pour tout importer.\n"
  );
}

createCustomers().catch((err) => {
  console.error("\n💥 Erreur fatale :", err.message);
  process.exit(1);
});
