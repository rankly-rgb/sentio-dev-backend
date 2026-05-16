/**
 * seed-150-demo-accounts.ts
 * Crée 150 clients Stripe de test avec abonnements, factures et profils variés.
 * Données couvrant les 30 derniers jours pour alimenter le scoring Sentio.
 *
 * Usage :
 *   npx tsx scripts/seed-150-demo-accounts.ts
 *
 * Prérequis :
 *   STRIPE_SECRET_KEY=sk_test_... (clé test uniquement)
 */

import Stripe from "stripe";

const STRIPE_SECRET_KEY =
  process.env.STRIPE_SECRET_KEY || "sk_test_REMPLACER_PAR_TA_CLE";

if (!STRIPE_SECRET_KEY.startsWith("sk_test_")) {
  console.error("❌ Utilise uniquement une clé TEST (sk_test_...)");
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2026-02-25.clover" });

// ─── CONFIG ────────────────────────────────────────────────────────────────────

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

// Dates utiles (timestamps Unix)
const daysAgo = (n: number) => NOW - n * DAY;

// ─── PLANS ─────────────────────────────────────────────────────────────────────

const PLAN_CONFIGS = [
  { label: "free",       name: "Free",       price_cents: 0,      seats_default: 1  },
  { label: "starter",    name: "Starter",    price_cents: 4900,   seats_default: 2  },
  { label: "pro",        name: "Pro",        price_cents: 14900,  seats_default: 5  },
  { label: "business",   name: "Business",   price_cents: 39900,  seats_default: 15 },
  { label: "enterprise", name: "Enterprise", price_cents: 99900,  seats_default: 80 },
];

// ─── DONNÉES ENTREPRISES (150 profils) ─────────────────────────────────────────

const INDUSTRIES = [
  "SaaS B2B", "Fintech", "EdTech", "Santé / Medtech", "E-commerce",
  "Marketplace", "Logistique", "RH / HRTech", "Cybersécurité", "Immobilier",
];

const COUNTRIES = ["FR", "DE", "GB", "US", "ES", "NL", "BE", "CA", "CH", "IT"];

interface CustomerDef {
  name: string;
  email: string;
  industry: string;
  country: string;
  company_size: string;
  plan: string;
  mrr: number;
  seats: number;
  churn_risk: "low" | "medium" | "high";
  payment_behavior: "on_time" | "late" | "failed_once" | "churned";
  created_days_ago: number; // ancienneté du client
  sub_days_ago: number;     // ancienneté de l'abonnement
  overdue_invoice?: boolean; // facture impayée à créer
  notes: string;
}

const CUSTOMERS: CustomerDef[] = [
  // ── ENTERPRISE — Champions (10) ────────────────────────────────────────────
  {
    name: "Nexora Systems", email: "billing@nexora-systems.com",
    industry: "SaaS B2B", country: "FR", company_size: "500+",
    plan: "enterprise", mrr: 2490, seats: 120, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 365, sub_days_ago: 300,
    notes: "Client flagship, contrat annuel, NPS 9/10",
  },
  {
    name: "Velox Finance", email: "accounts@veloxfinance.io",
    industry: "Fintech", country: "DE", company_size: "201-500",
    plan: "enterprise", mrr: 1980, seats: 85, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 420, sub_days_ago: 400,
    notes: "Renouvellement auto, expansion prévue Q3",
  },
  {
    name: "Meridian Health", email: "finance@meridian-health.eu",
    industry: "Santé / Medtech", country: "GB", company_size: "500+",
    plan: "enterprise", mrr: 3200, seats: 200, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 540, sub_days_ago: 510,
    notes: "GDPR strict, CSM dédié",
  },
  {
    name: "Lumenark Education", email: "billing@lumenark.edu",
    industry: "EdTech", country: "CA", company_size: "201-500",
    plan: "enterprise", mrr: 1490, seats: 60, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 280, sub_days_ago: 260,
    notes: "Contrat 2 ans, formation en cours",
  },
  {
    name: "CloudBase Infrastructure", email: "billing@cloudbase.io",
    industry: "SaaS B2B", country: "US", company_size: "500+",
    plan: "enterprise", mrr: 4500, seats: 250, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 700, sub_days_ago: 680,
    notes: "Contrat pluriannuel, référence sectorielle",
  },
  {
    name: "DataStream Analytics", email: "finance@datastream.ai",
    industry: "SaaS B2B", country: "NL", company_size: "201-500",
    plan: "enterprise", mrr: 2100, seats: 95, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 380, sub_days_ago: 360,
    notes: "Usage intensif API, très satisfait",
  },
  {
    name: "Fortis Cybersec", email: "ops@fortis-cybersec.com",
    industry: "Cybersécurité", country: "US", company_size: "201-500",
    plan: "enterprise", mrr: 2800, seats: 110, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 450, sub_days_ago: 430,
    notes: "Certifications ISO 27001, intégration SSO",
  },
  {
    name: "Globex Logistics", email: "billing@globex-logistics.eu",
    industry: "Logistique", country: "DE", company_size: "500+",
    plan: "enterprise", mrr: 3600, seats: 180, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 600, sub_days_ago: 580,
    notes: "Multi-sites, ROI démontré",
  },
  {
    name: "Pharmalink Bio", email: "accounts@pharmalink.bio",
    industry: "Santé / Medtech", country: "CH", company_size: "201-500",
    plan: "enterprise", mrr: 1850, seats: 75, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 320, sub_days_ago: 300,
    notes: "Validation réglementaire FDA en cours",
  },
  {
    name: "PropTech Solutions", email: "finance@proptech-sol.fr",
    industry: "Immobilier", country: "FR", company_size: "201-500",
    plan: "enterprise", mrr: 1650, seats: 70, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 500, sub_days_ago: 470,
    notes: "Champion interne très actif",
  },

  // ── BUSINESS — En expansion (12) ────────────────────────────────────────────
  {
    name: "Orbitale SAS", email: "comptabilite@orbitale.fr",
    industry: "Marketplace", country: "FR", company_size: "51-200",
    plan: "business", mrr: 798, seats: 25, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 240, sub_days_ago: 220,
    notes: "Upsell Enterprise prévu Q3",
  },
  {
    name: "Shieldwave Security", email: "finance@shieldwave.io",
    industry: "Cybersécurité", country: "US", company_size: "11-50",
    plan: "business", mrr: 399, seats: 10, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 180, sub_days_ago: 160,
    notes: "Croissance rapide, potentiel Enterprise",
  },
  {
    name: "Wavemarket", email: "hello@wavemarket.fr",
    industry: "Marketplace", country: "FR", company_size: "11-50",
    plan: "business", mrr: 399, seats: 12, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 200, sub_days_ago: 185,
    notes: "Levée de fonds récente, budget validé",
  },
  {
    name: "Recrutix HR", email: "admin@recrutix.io",
    industry: "RH / HRTech", country: "BE", company_size: "11-50",
    plan: "business", mrr: 399, seats: 12, churn_risk: "medium",
    payment_behavior: "on_time", created_days_ago: 160, sub_days_ago: 140,
    notes: "Usage API intensif, surveiller quotas",
  },
  {
    name: "Synapse Learning", email: "billing@synapse-learning.io",
    industry: "EdTech", country: "FR", company_size: "51-200",
    plan: "business", mrr: 599, seats: 20, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 300, sub_days_ago: 280,
    notes: "Fort taux d'adoption, NPS 8/10",
  },
  {
    name: "Nexum Agency", email: "finance@nexum-agency.fr",
    industry: "SaaS B2B", country: "FR", company_size: "51-200",
    plan: "business", mrr: 399, seats: 15, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 220, sub_days_ago: 200,
    notes: "Agence digitale en croissance",
  },
  {
    name: "BioMed Analytics", email: "ops@biomed-analytics.eu",
    industry: "Santé / Medtech", country: "DE", company_size: "51-200",
    plan: "business", mrr: 499, seats: 18, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 260, sub_days_ago: 240,
    notes: "Partenariat revendeur possible",
  },
  {
    name: "Stackify Dev", email: "billing@stackify.dev",
    industry: "SaaS B2B", country: "GB", company_size: "11-50",
    plan: "business", mrr: 399, seats: 10, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 140, sub_days_ago: 120,
    notes: "Startup tech très engagée",
  },
  {
    name: "MedCare Solutions", email: "admin@medcare-sol.fr",
    industry: "Santé / Medtech", country: "FR", company_size: "51-200",
    plan: "business", mrr: 599, seats: 22, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 350, sub_days_ago: 330,
    notes: "Contrat pluriannuel, satisfaction élevée",
  },
  {
    name: "FinEdge Capital", email: "billing@finedge.capital",
    industry: "Fintech", country: "LU", company_size: "51-200",
    plan: "business", mrr: 599, seats: 20, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 290, sub_days_ago: 270,
    notes: "Régulation MiFID, conformité stricte",
  },
  {
    name: "Logitrans Express", email: "ops@logitrans.fr",
    industry: "Logistique", country: "FR", company_size: "51-200",
    plan: "business", mrr: 399, seats: 14, churn_risk: "medium",
    payment_behavior: "on_time", created_days_ago: 180, sub_days_ago: 160,
    notes: "Saisonnalité décembre forte",
  },
  {
    name: "Infosec Partners", email: "billing@infosec-partners.io",
    industry: "Cybersécurité", country: "BE", company_size: "11-50",
    plan: "business", mrr: 399, seats: 10, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 210, sub_days_ago: 190,
    notes: "Renouvellement confirmé",
  },

  // ── BUSINESS — À risque (8) ─────────────────────────────────────────────────
  {
    name: "Cargoway Logistics", email: "ops@cargoway.de",
    industry: "Logistique", country: "DE", company_size: "51-200",
    plan: "business", mrr: 399, seats: 18, churn_risk: "medium",
    payment_behavior: "late", created_days_ago: 380, sub_days_ago: 360,
    notes: "Paiements souvent en retard de 5-10j",
  },
  {
    name: "Proptech Immo", email: "direction@proptech-immo.fr",
    industry: "Immobilier", country: "FR", company_size: "11-50",
    plan: "business", mrr: 399, seats: 8, churn_risk: "high",
    payment_behavior: "failed_once", created_days_ago: 420, sub_days_ago: 400,
    overdue_invoice: true,
    notes: "Paiement échoué, engagement faible",
  },
  {
    name: "RetailFlow Inc", email: "billing@retailflow.com",
    industry: "E-commerce", country: "US", company_size: "51-200",
    plan: "business", mrr: 399, seats: 14, churn_risk: "high",
    payment_behavior: "late", created_days_ago: 300, sub_days_ago: 280,
    overdue_invoice: true,
    notes: "Usage en baisse de 40% ce mois",
  },
  {
    name: "Urbanify Proptech", email: "admin@urbanify.fr",
    industry: "Immobilier", country: "FR", company_size: "11-50",
    plan: "business", mrr: 399, seats: 9, churn_risk: "high",
    payment_behavior: "failed_once", created_days_ago: 250, sub_days_ago: 230,
    notes: "Évalue solution concurrente",
  },
  {
    name: "Flexwork HR", email: "ops@flexwork.io",
    industry: "RH / HRTech", country: "ES", company_size: "11-50",
    plan: "business", mrr: 399, seats: 10, churn_risk: "high",
    payment_behavior: "late", created_days_ago: 320, sub_days_ago: 300,
    overdue_invoice: true,
    notes: "ROI non démontré, renouvellement incertain",
  },
  {
    name: "Marché Direct", email: "billing@marche-direct.fr",
    industry: "E-commerce", country: "FR", company_size: "11-50",
    plan: "business", mrr: 399, seats: 11, churn_risk: "medium",
    payment_behavior: "late", created_days_ago: 200, sub_days_ago: 180,
    notes: "Saisonnalité, budget serré",
  },
  {
    name: "Techvibe Studio", email: "admin@techvibe.io",
    industry: "SaaS B2B", country: "IT", company_size: "11-50",
    plan: "business", mrr: 399, seats: 8, churn_risk: "high",
    payment_behavior: "failed_once", created_days_ago: 280, sub_days_ago: 260,
    overdue_invoice: true,
    notes: "Champion parti, nouveau contact non qualifié",
  },
  {
    name: "Kreative Media", email: "finance@kreative-media.fr",
    industry: "Marketplace", country: "FR", company_size: "11-50",
    plan: "business", mrr: 399, seats: 10, churn_risk: "high",
    payment_behavior: "late", created_days_ago: 340, sub_days_ago: 320,
    notes: "Merge en cours, décision suspendue",
  },

  // ── PRO — Stables (20) ─────────────────────────────────────────────────────
  {
    name: "Datastride Analytics", email: "billing@datastride.io",
    industry: "SaaS B2B", country: "NL", company_size: "11-50",
    plan: "pro", mrr: 298, seats: 6, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 500, sub_days_ago: 480,
    notes: "Champion, fort referral potentiel",
  },
  {
    name: "Pulse Medtech", email: "admin@pulse-medtech.ch",
    industry: "Santé / Medtech", country: "CH", company_size: "1-10",
    plan: "pro", mrr: 298, seats: 3, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 280, sub_days_ago: 260,
    notes: "Startup série A, expansion prévue",
  },
  {
    name: "Finspark Technologies", email: "billing@finspark.io",
    industry: "Fintech", country: "IT", company_size: "1-10",
    plan: "pro", mrr: 149, seats: 3, churn_risk: "medium",
    payment_behavior: "on_time", created_days_ago: 190, sub_days_ago: 170,
    notes: "Validation réglementaire en attente",
  },
  {
    name: "Solaris Energy", email: "ops@solaris-energy.io",
    industry: "SaaS B2B", country: "FR", company_size: "11-50",
    plan: "pro", mrr: 149, seats: 4, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 400, sub_days_ago: 380,
    notes: "Secteur ENR, croissance régulière",
  },
  {
    name: "Codecraft Agency", email: "billing@codecraft.dev",
    industry: "SaaS B2B", country: "BE", company_size: "1-10",
    plan: "pro", mrr: 149, seats: 3, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 350, sub_days_ago: 330,
    notes: "Agence fidèle depuis 1 an",
  },
  {
    name: "OptiLog France", email: "admin@optilog.fr",
    industry: "Logistique", country: "FR", company_size: "11-50",
    plan: "pro", mrr: 298, seats: 7, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 420, sub_days_ago: 400,
    notes: "Intégration ERP réussie",
  },
  {
    name: "LegalTech Pro", email: "billing@legaltech.fr",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "pro", mrr: 149, seats: 2, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 300, sub_days_ago: 280,
    notes: "Cabinets d'avocats, très satisfait",
  },
  {
    name: "Greenleaf Agri", email: "ops@greenleaf-agri.fr",
    industry: "SaaS B2B", country: "FR", company_size: "11-50",
    plan: "pro", mrr: 149, seats: 4, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 250, sub_days_ago: 230,
    notes: "Secteur agricole, usage stable",
  },
  {
    name: "Mediapro Studio", email: "billing@mediapro.fr",
    industry: "Marketplace", country: "FR", company_size: "11-50",
    plan: "pro", mrr: 298, seats: 6, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 380, sub_days_ago: 360,
    notes: "Très actif, potentiel Business",
  },
  {
    name: "Finvault Solutions", email: "admin@finvault.io",
    industry: "Fintech", country: "FR", company_size: "11-50",
    plan: "pro", mrr: 298, seats: 5, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 460, sub_days_ago: 440,
    notes: "Conformité DSP2, stable",
  },
  {
    name: "Caravel Commerce", email: "ops@caravelcommerce.eu",
    industry: "E-commerce", country: "ES", company_size: "11-50",
    plan: "pro", mrr: 149, seats: 4, churn_risk: "medium",
    payment_behavior: "on_time", created_days_ago: 280, sub_days_ago: 260,
    notes: "Saisonnalité forte (Noël/été)",
  },
  {
    name: "TechSpark Labs", email: "billing@techspark.io",
    industry: "SaaS B2B", country: "GB", company_size: "1-10",
    plan: "pro", mrr: 149, seats: 3, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 220, sub_days_ago: 200,
    notes: "Startup prometteuse, bon NPS",
  },
  {
    name: "Arivo Consulting", email: "admin@arivo.fr",
    industry: "RH / HRTech", country: "FR", company_size: "11-50",
    plan: "pro", mrr: 298, seats: 7, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 320, sub_days_ago: 300,
    notes: "Cabinet RH, usage mensuel régulier",
  },
  {
    name: "NordData Systems", email: "billing@norddata.se",
    industry: "SaaS B2B", country: "DE", company_size: "11-50",
    plan: "pro", mrr: 149, seats: 3, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 360, sub_days_ago: 340,
    notes: "Marché nordique, fidèle",
  },
  {
    name: "Apexo Finance", email: "finance@apexo.io",
    industry: "Fintech", country: "FR", company_size: "11-50",
    plan: "pro", mrr: 149, seats: 4, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 410, sub_days_ago: 390,
    notes: "Conformité ACPR, stable",
  },
  {
    name: "EduBoost Platform", email: "ops@eduboost.fr",
    industry: "EdTech", country: "FR", company_size: "11-50",
    plan: "pro", mrr: 298, seats: 6, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 270, sub_days_ago: 250,
    notes: "Croissance des licences ce trimestre",
  },
  {
    name: "HealthTrack Pro", email: "billing@healthtrack.io",
    industry: "Santé / Medtech", country: "BE", company_size: "1-10",
    plan: "pro", mrr: 149, seats: 2, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 190, sub_days_ago: 170,
    notes: "Télémédecine, croissance post-Covid",
  },
  {
    name: "Securelink IT", email: "admin@securelink.be",
    industry: "Cybersécurité", country: "BE", company_size: "11-50",
    plan: "pro", mrr: 298, seats: 6, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 340, sub_days_ago: 320,
    notes: "SOC externalisé, renouvellement garanti",
  },
  {
    name: "Zenlink Commerce", email: "billing@zenlink.fr",
    industry: "E-commerce", country: "FR", company_size: "11-50",
    plan: "pro", mrr: 149, seats: 3, churn_risk: "medium",
    payment_behavior: "on_time", created_days_ago: 230, sub_days_ago: 210,
    notes: "Croissance lente mais constante",
  },
  {
    name: "Lumino Digital", email: "admin@lumino-digital.fr",
    industry: "Marketplace", country: "FR", company_size: "11-50",
    plan: "pro", mrr: 149, seats: 4, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 290, sub_days_ago: 270,
    notes: "Utilisateur actif, feature requests réguliers",
  },

  // ── PRO — À risque (10) ─────────────────────────────────────────────────────
  {
    name: "Traffiq Agency", email: "admin@traffiq-agency.com",
    industry: "SaaS B2B", country: "GB", company_size: "11-50",
    plan: "pro", mrr: 149, seats: 2, churn_risk: "high",
    payment_behavior: "failed_once", created_days_ago: 350, sub_days_ago: 330,
    overdue_invoice: true,
    notes: "Carte expirée, mise à jour en attente",
  },
  {
    name: "Edunova Labs", email: "contact@edunova-labs.fr",
    industry: "EdTech", country: "FR", company_size: "1-10",
    plan: "pro", mrr: 149, seats: 2, churn_risk: "high",
    payment_behavior: "late", created_days_ago: 300, sub_days_ago: 280,
    notes: "Login < 1x/semaine, churn imminent",
  },
  {
    name: "Mobilux App", email: "billing@mobilux.io",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "pro", mrr: 149, seats: 2, churn_risk: "high",
    payment_behavior: "failed_once", created_days_ago: 200, sub_days_ago: 180,
    overdue_invoice: true,
    notes: "Pivot produit, budget gelé",
  },
  {
    name: "Fastrent Immo", email: "ops@fastrent.fr",
    industry: "Immobilier", country: "FR", company_size: "1-10",
    plan: "pro", mrr: 149, seats: 2, churn_risk: "high",
    payment_behavior: "late", created_days_ago: 260, sub_days_ago: 240,
    notes: "Marché immobilier difficile, gel budget",
  },
  {
    name: "InnovatED School", email: "admin@innovated.fr",
    industry: "EdTech", country: "FR", company_size: "1-10",
    plan: "pro", mrr: 149, seats: 2, churn_risk: "high",
    payment_behavior: "failed_once", created_days_ago: 180, sub_days_ago: 160,
    overdue_invoice: true,
    notes: "Pas connecté depuis 45 jours",
  },
  {
    name: "RentSmart", email: "billing@rentsmart.io",
    industry: "Immobilier", country: "ES", company_size: "1-10",
    plan: "pro", mrr: 149, seats: 2, churn_risk: "high",
    payment_behavior: "late", created_days_ago: 310, sub_days_ago: 290,
    notes: "Champion interne démissionné",
  },
  {
    name: "Voxify Media", email: "admin@voxify.fr",
    industry: "Marketplace", country: "FR", company_size: "1-10",
    plan: "pro", mrr: 149, seats: 2, churn_risk: "high",
    payment_behavior: "failed_once", created_days_ago: 220, sub_days_ago: 200,
    notes: "Arrêt activité possible",
  },
  {
    name: "AutoClass AI", email: "billing@autoclass.ai",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "pro", mrr: 149, seats: 2, churn_risk: "medium",
    payment_behavior: "late", created_days_ago: 170, sub_days_ago: 150,
    notes: "Investissement IA suspendu",
  },
  {
    name: "Cleara CRM", email: "ops@cleara-crm.io",
    industry: "SaaS B2B", country: "BE", company_size: "1-10",
    plan: "pro", mrr: 149, seats: 3, churn_risk: "high",
    payment_behavior: "late", created_days_ago: 280, sub_days_ago: 260,
    notes: "Concurrent moins cher en évaluation",
  },
  {
    name: "BlueSky Ventures", email: "finance@bluesky.vc",
    industry: "Fintech", country: "FR", company_size: "1-10",
    plan: "pro", mrr: 149, seats: 2, churn_risk: "high",
    payment_behavior: "failed_once", created_days_ago: 240, sub_days_ago: 220,
    overdue_invoice: true,
    notes: "Startup en difficulté de trésorerie",
  },

  // ── STARTER — Stables (20) ─────────────────────────────────────────────────
  {
    name: "Greenbyte Energy", email: "billing@greenbyte.energy",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 540, sub_days_ago: 520,
    notes: "Fidèle depuis 18 mois, startup early-stage",
  },
  {
    name: "Terrabit Immo", email: "admin@terrabit-immo.fr",
    industry: "Immobilier", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 460, sub_days_ago: 440,
    notes: "Agent indépendant, très satisfait",
  },
  {
    name: "Luminos Conseil", email: "contact@luminos-conseil.fr",
    industry: "RH / HRTech", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 2, churn_risk: "medium",
    payment_behavior: "on_time", created_days_ago: 380, sub_days_ago: 360,
    notes: "Cabinet de conseil, usage modéré",
  },
  {
    name: "Brise Formations", email: "billing@brise-formations.fr",
    industry: "EdTech", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 300, sub_days_ago: 280,
    notes: "Organisme de formation, stable",
  },
  {
    name: "Noctua Legal", email: "admin@noctua-legal.fr",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 2, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 410, sub_days_ago: 390,
    notes: "Cabinet juridique, usage mensuel",
  },
  {
    name: "Freelink Pro", email: "billing@freelink.pro",
    industry: "Marketplace", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 260, sub_days_ago: 240,
    notes: "Indépendant, fidèle",
  },
  {
    name: "Microtek Solutions", email: "ops@microtek-sol.fr",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 350, sub_days_ago: 330,
    notes: "TPE tech, satisfait",
  },
  {
    name: "Koda Dev Studio", email: "hello@koda.dev",
    industry: "SaaS B2B", country: "BE", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "medium",
    payment_behavior: "late", created_days_ago: 290, sub_days_ago: 270,
    notes: "Petite agence, paiement tardif habituel",
  },
  {
    name: "Artisan Web", email: "contact@artisan-web.fr",
    industry: "Marketplace", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 200, sub_days_ago: 180,
    notes: "Freelance web, actif",
  },
  {
    name: "Velum Architecture", email: "billing@velum.fr",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 2, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 320, sub_days_ago: 300,
    notes: "Cabinet archi, cas usage niche",
  },
  {
    name: "FlexPack Logistique", email: "admin@flexpack.fr",
    industry: "Logistique", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 230, sub_days_ago: 210,
    notes: "PME logistique, usage hebdo",
  },
  {
    name: "Sante Directe", email: "billing@sante-directe.fr",
    industry: "Santé / Medtech", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 400, sub_days_ago: 380,
    notes: "Médecin indépendant, fidèle",
  },
  {
    name: "Nomado Travel", email: "finance@nomado-travel.eu",
    industry: "Marketplace", country: "ES", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 2, churn_risk: "medium",
    payment_behavior: "on_time", created_days_ago: 270, sub_days_ago: 250,
    notes: "Évalue concurrents, croissance lente",
  },
  {
    name: "DigiCoach Sport", email: "contact@digicoach.fr",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 190, sub_days_ago: 170,
    notes: "Coach sportif digitalisé, actif",
  },
  {
    name: "PhotoSync Pro", email: "billing@photosync.io",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 160, sub_days_ago: 140,
    notes: "Photographe professionnel, fidèle",
  },
  {
    name: "ComptaClick", email: "admin@comptaclick.fr",
    industry: "Fintech", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 2, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 440, sub_days_ago: 420,
    notes: "Expert-comptable indépendant, très fidèle",
  },
  {
    name: "Birdy Events", email: "contact@birdy-events.fr",
    industry: "Marketplace", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "medium",
    payment_behavior: "on_time", created_days_ago: 210, sub_days_ago: 190,
    notes: "Organisateur événements, saisonnier",
  },
  {
    name: "Creatif Studio", email: "billing@creatif-studio.fr",
    industry: "Marketplace", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 330, sub_days_ago: 310,
    notes: "Studio créatif, actif et satisfait",
  },
  {
    name: "Bâti Rénov Pro", email: "admin@batirenovpro.fr",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 250, sub_days_ago: 230,
    notes: "Artisan BTP, usage basique mais stable",
  },
  {
    name: "Formavie RH", email: "contact@formavie-rh.fr",
    industry: "RH / HRTech", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 2, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 370, sub_days_ago: 350,
    notes: "Cabinet conseil RH, renouvelle chaque année",
  },

  // ── STARTER — À risque (10) ────────────────────────────────────────────────
  {
    name: "Pixelcraft Agency", email: "billing@pixelcraft-agency.com",
    industry: "SaaS B2B", country: "BE", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "high",
    payment_behavior: "late", created_days_ago: 300, sub_days_ago: 280,
    notes: "Usage quasi nul, candidat churn prochain mois",
  },
  {
    name: "Shopflux E-com", email: "ops@shopflux.io",
    industry: "E-commerce", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "high",
    payment_behavior: "failed_once", created_days_ago: 250, sub_days_ago: 230,
    overdue_invoice: true,
    notes: "Pas connecté depuis 3 semaines",
  },
  {
    name: "Click & Sell", email: "billing@clicksell.fr",
    industry: "E-commerce", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "high",
    payment_behavior: "late", created_days_ago: 180, sub_days_ago: 160,
    notes: "Budget coupé, usage minimal",
  },
  {
    name: "DevForge Studio", email: "admin@devforge.io",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "high",
    payment_behavior: "failed_once", created_days_ago: 220, sub_days_ago: 200,
    overdue_invoice: true,
    notes: "Fondateur seul, projets multiples",
  },
  {
    name: "Artisanat Digital", email: "contact@artisanat-digital.fr",
    industry: "Marketplace", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "high",
    payment_behavior: "late", created_days_ago: 290, sub_days_ago: 270,
    notes: "Artisan peu tech, engagement faible",
  },
  {
    name: "Webmaster Plus", email: "billing@webmaster-plus.fr",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "high",
    payment_behavior: "late", created_days_ago: 340, sub_days_ago: 320,
    notes: "Factures en retard régulièrement",
  },
  {
    name: "PictoSign", email: "admin@pictosign.fr",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "high",
    payment_behavior: "failed_once", created_days_ago: 200, sub_days_ago: 180,
    overdue_invoice: true,
    notes: "Paiement échoué x2, à surveiller",
  },
  {
    name: "CafePro Manager", email: "billing@cafepro.fr",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "high",
    payment_behavior: "late", created_days_ago: 260, sub_days_ago: 240,
    notes: "Restaurant, budget très serré",
  },
  {
    name: "InfoPass Agency", email: "contact@infopass.fr",
    industry: "Marketplace", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "high",
    payment_behavior: "failed_once", created_days_ago: 170, sub_days_ago: 150,
    notes: "Activité secondaire, peu prioritaire",
  },
  {
    name: "SnapBuild SaaS", email: "billing@snapbuild.io",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "high",
    payment_behavior: "late", created_days_ago: 310, sub_days_ago: 290,
    notes: "Pivote, feature set insuffisant",
  },

  // ── NOUVEAUX (< 30 jours) — 15 comptes ────────────────────────────────────
  {
    name: "Zephyr AI", email: "billing@zephyr.ai",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "pro", mrr: 149, seats: 3, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 7, sub_days_ago: 7,
    notes: "Nouveau client, très actif en onboarding",
  },
  {
    name: "Lumières RH", email: "admin@lumieres-rh.fr",
    industry: "RH / HRTech", country: "FR", company_size: "11-50",
    plan: "business", mrr: 399, seats: 12, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 12, sub_days_ago: 12,
    notes: "Onboarding en cours, équipe engagée",
  },
  {
    name: "CloudSync Pro", email: "billing@cloudsync.pro",
    industry: "SaaS B2B", country: "DE", company_size: "11-50",
    plan: "business", mrr: 399, seats: 10, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 5, sub_days_ago: 5,
    notes: "Migration depuis concurrent réussie",
  },
  {
    name: "EduPlay Kids", email: "contact@eduplay-kids.fr",
    industry: "EdTech", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 2, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 20, sub_days_ago: 20,
    notes: "EdTech jeunesse, démo convaincante",
  },
  {
    name: "Quantum Finance", email: "ops@quantum-finance.io",
    industry: "Fintech", country: "FR", company_size: "11-50",
    plan: "pro", mrr: 298, seats: 5, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 15, sub_days_ago: 15,
    notes: "Fintech innovante, beaucoup de questions support",
  },
  {
    name: "NeoMed Health", email: "billing@neomed.io",
    industry: "Santé / Medtech", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 10, sub_days_ago: 10,
    notes: "Réseau de médecins, potentiel fort",
  },
  {
    name: "Hexalabs Tech", email: "admin@hexalabs.io",
    industry: "SaaS B2B", country: "FR", company_size: "11-50",
    plan: "pro", mrr: 149, seats: 3, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 18, sub_days_ago: 18,
    notes: "Références clients solides",
  },
  {
    name: "Agilify Ops", email: "billing@agilify.io",
    industry: "SaaS B2B", country: "BE", company_size: "11-50",
    plan: "pro", mrr: 149, seats: 4, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 25, sub_days_ago: 25,
    notes: "Intégration rapide, équipe tech expérimentée",
  },
  {
    name: "GreenRoute Logistics", email: "ops@greenroute.fr",
    industry: "Logistique", country: "FR", company_size: "11-50",
    plan: "business", mrr: 399, seats: 13, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 8, sub_days_ago: 8,
    notes: "Logistique verte, subvention ADEME",
  },
  {
    name: "Medis Pharma", email: "billing@medis-pharma.fr",
    industry: "Santé / Medtech", country: "FR", company_size: "51-200",
    plan: "business", mrr: 499, seats: 16, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 22, sub_days_ago: 22,
    notes: "Labo pharmaceutique, bon potentiel Enterprise",
  },
  {
    name: "SparkSales CRM", email: "admin@sparksales.io",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 2, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 14, sub_days_ago: 14,
    notes: "Commerciaux enthousiasme, adoption rapide",
  },
  {
    name: "SecureVault SaaS", email: "billing@securevault.io",
    industry: "Cybersécurité", country: "FR", company_size: "11-50",
    plan: "pro", mrr: 149, seats: 3, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 28, sub_days_ago: 28,
    notes: "Startup cybersec bien financée",
  },
  {
    name: "Imo Connect", email: "ops@imo-connect.fr",
    industry: "Immobilier", country: "FR", company_size: "11-50",
    plan: "pro", mrr: 149, seats: 4, churn_risk: "medium",
    payment_behavior: "on_time", created_days_ago: 17, sub_days_ago: 17,
    notes: "Réseau d'agents, intégration en cours",
  },
  {
    name: "DataPulse Analytics", email: "billing@datapulse.io",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "starter", mrr: 49, seats: 1, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 3, sub_days_ago: 3,
    notes: "Trial converti hier, très motivé",
  },
  {
    name: "Carbo Climate", email: "admin@carbo-climate.fr",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "pro", mrr: 149, seats: 2, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 27, sub_days_ago: 27,
    notes: "GreenTech, subventions ADEME attendues",
  },

  // ── FREE / TRIAL (15) ───────────────────────────────────────────────────────
  {
    name: "Betaforge Labs", email: "founders@betaforge.io",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "free", mrr: 0, seats: 1, churn_risk: "medium",
    payment_behavior: "on_time", created_days_ago: 14, sub_days_ago: 14,
    notes: "Trial actif, démo planifiée",
  },
  {
    name: "Claraview Analytics", email: "trial@claraview.ai",
    industry: "SaaS B2B", country: "US", company_size: "1-10",
    plan: "free", mrr: 0, seats: 2, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 10, sub_days_ago: 10,
    notes: "Très actif en trial, conversion probable",
  },
  {
    name: "Mobitrack Solutions", email: "contact@mobitrack.fr",
    industry: "Logistique", country: "FR", company_size: "1-10",
    plan: "free", mrr: 0, seats: 1, churn_risk: "high",
    payment_behavior: "on_time", created_days_ago: 25, sub_days_ago: 25,
    notes: "Trial 25j, aucune action significative",
  },
  {
    name: "Arclight Media", email: "billing@arclight-media.fr",
    industry: "Marketplace", country: "FR", company_size: "1-10",
    plan: "free", mrr: 0, seats: 1, churn_risk: "medium",
    payment_behavior: "on_time", created_days_ago: 20, sub_days_ago: 20,
    notes: "En évaluation vs concurrent",
  },
  {
    name: "Startopia Inc", email: "hello@startopia.io",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "free", mrr: 0, seats: 2, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 6, sub_days_ago: 6,
    notes: "Fondateurs actifs, POC en cours",
  },
  {
    name: "Buildup Platform", email: "admin@buildup.io",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "free", mrr: 0, seats: 1, churn_risk: "medium",
    payment_behavior: "on_time", created_days_ago: 18, sub_days_ago: 18,
    notes: "Y Combinator applicant",
  },
  {
    name: "NanoScale AI", email: "billing@nanoscale.ai",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "free", mrr: 0, seats: 1, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 9, sub_days_ago: 9,
    notes: "IA startup, très tech-savvy",
  },
  {
    name: "PetCare Pro", email: "ops@petcare-pro.fr",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "free", mrr: 0, seats: 1, churn_risk: "high",
    payment_behavior: "on_time", created_days_ago: 28, sub_days_ago: 28,
    notes: "Vétérinaire, usage très sporadique",
  },
  {
    name: "Geofleet Tracking", email: "billing@geofleet.io",
    industry: "Logistique", country: "FR", company_size: "1-10",
    plan: "free", mrr: 0, seats: 2, churn_risk: "medium",
    payment_behavior: "on_time", created_days_ago: 13, sub_days_ago: 13,
    notes: "Flotte vehicules, intégration GPS envisagée",
  },
  {
    name: "BioScan Labs", email: "admin@bioscan-labs.fr",
    industry: "Santé / Medtech", country: "FR", company_size: "1-10",
    plan: "free", mrr: 0, seats: 1, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 5, sub_days_ago: 5,
    notes: "Biotech startup, forte motivation",
  },
  {
    name: "ClickHarvest", email: "billing@clickharvest.fr",
    industry: "E-commerce", country: "FR", company_size: "1-10",
    plan: "free", mrr: 0, seats: 1, churn_risk: "high",
    payment_behavior: "on_time", created_days_ago: 29, sub_days_ago: 29,
    notes: "E-commerce débutant, peu d'engagement",
  },
  {
    name: "FoodTech Platform", email: "contact@foodtech.fr",
    industry: "Marketplace", country: "FR", company_size: "1-10",
    plan: "free", mrr: 0, seats: 2, churn_risk: "medium",
    payment_behavior: "on_time", created_days_ago: 11, sub_days_ago: 11,
    notes: "Plateforme restaurateurs, modèle en test",
  },
  {
    name: "LegalAI France", email: "admin@legalai.fr",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "free", mrr: 0, seats: 1, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 7, sub_days_ago: 7,
    notes: "LegalTech AI, partenariat envisagé",
  },
  {
    name: "TestDrive Labs", email: "billing@testdrive.io",
    industry: "SaaS B2B", country: "FR", company_size: "1-10",
    plan: "free", mrr: 0, seats: 1, churn_risk: "medium",
    payment_behavior: "on_time", created_days_ago: 23, sub_days_ago: 23,
    notes: "Evaluation en cours",
  },
  {
    name: "WinSales Academy", email: "contact@winsales.fr",
    industry: "RH / HRTech", country: "FR", company_size: "1-10",
    plan: "free", mrr: 0, seats: 2, churn_risk: "low",
    payment_behavior: "on_time", created_days_ago: 4, sub_days_ago: 4,
    notes: "Sales enablement, très enthousiaste",
  },

  // ── CHURNED (10) ───────────────────────────────────────────────────────────
  {
    name: "Axionex Corp", email: "ex-billing@axionex.com",
    industry: "Fintech", country: "US", company_size: "11-50",
    plan: "pro", mrr: 0, seats: 0, churn_risk: "high",
    payment_behavior: "churned", created_days_ago: 480, sub_days_ago: 460,
    notes: "Churné il y a 2 mois, budget coupé",
  },
  {
    name: "Greystone Consulting", email: "old@greystone-consulting.eu",
    industry: "RH / HRTech", country: "DE", company_size: "11-50",
    plan: "starter", mrr: 0, seats: 0, churn_risk: "high",
    payment_behavior: "churned", created_days_ago: 520, sub_days_ago: 500,
    notes: "Churné il y a 3 mois, concurrent moins cher",
  },
  {
    name: "Paxflow Logistics", email: "billing@paxflow.de",
    industry: "Logistique", country: "DE", company_size: "51-200",
    plan: "business", mrr: 0, seats: 0, churn_risk: "high",
    payment_behavior: "churned", created_days_ago: 400, sub_days_ago: 380,
    notes: "Fusion-acquisition, décision gelée",
  },
  {
    name: "Redwood Media", email: "ops@redwood-media.com",
    industry: "Marketplace", country: "US", company_size: "11-50",
    plan: "pro", mrr: 0, seats: 0, churn_risk: "high",
    payment_behavior: "churned", created_days_ago: 350, sub_days_ago: 330,
    notes: "Startup fermée",
  },
  {
    name: "Bluerock Finance", email: "billing@bluerock.io",
    industry: "Fintech", country: "GB", company_size: "11-50",
    plan: "pro", mrr: 0, seats: 0, churn_risk: "high",
    payment_behavior: "churned", created_days_ago: 430, sub_days_ago: 410,
    notes: "Réglementation britannique post-Brexit",
  },
  {
    name: "Suntech Solar", email: "admin@suntech-solar.fr",
    industry: "SaaS B2B", country: "FR", company_size: "11-50",
    plan: "starter", mrr: 0, seats: 0, churn_risk: "high",
    payment_behavior: "churned", created_days_ago: 360, sub_days_ago: 340,
    notes: "Activité principale ralentie",
  },
  {
    name: "CraftBrew Analytics", email: "billing@craftbrew.io",
    industry: "SaaS B2B", country: "BE", company_size: "1-10",
    plan: "starter", mrr: 0, seats: 0, churn_risk: "high",
    payment_behavior: "churned", created_days_ago: 290, sub_days_ago: 270,
    notes: "Budget limité, gratuit suffit",
  },
  {
    name: "Mediasphere Group", email: "ops@mediasphere.fr",
    industry: "Marketplace", country: "FR", company_size: "51-200",
    plan: "business", mrr: 0, seats: 0, churn_risk: "high",
    payment_behavior: "churned", created_days_ago: 500, sub_days_ago: 480,
    notes: "Restructuration interne, outil non prioritaire",
  },
  {
    name: "Optima Healthcare", email: "billing@optima-health.eu",
    industry: "Santé / Medtech", country: "ES", company_size: "51-200",
    plan: "business", mrr: 0, seats: 0, churn_risk: "high",
    payment_behavior: "churned", created_days_ago: 460, sub_days_ago: 440,
    notes: "Retour sur solution on-premise",
  },
  {
    name: "Flexrent SaaS", email: "admin@flexrent.io",
    industry: "Immobilier", country: "FR", company_size: "11-50",
    plan: "pro", mrr: 0, seats: 0, churn_risk: "high",
    payment_behavior: "churned", created_days_ago: 330, sub_days_ago: 310,
    notes: "Pivot vers autre secteur",
  },
];

// ─── UTILITAIRES ──────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function planConfig(label: string) {
  return PLAN_CONFIGS.find((p) => p.label === label) ?? PLAN_CONFIGS[0];
}

// ─── ÉTAPE 1 : Créer les produits & prix Stripe ───────────────────────────────

async function ensureProductsAndPrices(): Promise<Map<string, string>> {
  console.log("\n📦 Vérification / création des produits Stripe...\n");

  const priceIdByPlan = new Map<string, string>();

  for (const plan of PLAN_CONFIGS) {
    if (plan.price_cents === 0) {
      priceIdByPlan.set(plan.label, "free");
      continue;
    }

    // Cherche un prix existant avec ce metadata
    const existingPrices = await stripe.prices.list({
      active: true,
      type: "recurring",
      limit: 100,
    });

    const existing = existingPrices.data.find(
      (p) =>
        p.metadata?.sentio_plan === plan.label &&
        p.metadata?.sentio_seed === "true"
    );

    if (existing) {
      console.log(`  ♻️  Réutilise prix ${plan.name} → ${existing.id}`);
      priceIdByPlan.set(plan.label, existing.id);
      continue;
    }

    // Crée le produit
    const product = await stripe.products.create({
      name: `Sentio AI — ${plan.name}`,
      metadata: { sentio_plan: plan.label, sentio_seed: "true" },
    });

    // Crée le prix mensuel
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: plan.price_cents,
      currency: "eur",
      recurring: { interval: "month" },
      metadata: { sentio_plan: plan.label, sentio_seed: "true" },
    });

    console.log(`  ✅ Créé ${plan.name} → ${price.id} (${plan.price_cents / 100}€/mois)`);
    priceIdByPlan.set(plan.label, price.id);
    await sleep(200);
  }

  return priceIdByPlan;
}

// ─── ÉTAPE 2 : Créer un client Stripe ─────────────────────────────────────────

async function createCustomer(c: CustomerDef): Promise<string> {
  const plan = planConfig(c.plan);

  const customer = await stripe.customers.create({
    name: c.name,
    email: c.email,
    metadata: {
      industry: c.industry,
      company_size: c.company_size,
      plan: c.plan,
      mrr_cents: String(c.mrr * 100),
      churn_risk: c.churn_risk,
      payment_behavior: c.payment_behavior,
      seats: String(c.seats),
      notes: c.notes,
      sentio_test_customer: "true",
    },
    address: { country: c.country },
    description: `[TEST] ${c.industry} — Plan ${plan.name} — ${c.churn_risk} risk`,
    preferred_locales: ["fr", "de", "es"].includes(c.country.toLowerCase())
      ? [`${c.country.toLowerCase()}-${c.country}`]
      : ["en-US"],
  });

  return customer.id;
}

// ─── ÉTAPE 3 : Créer un abonnement ────────────────────────────────────────────

async function createSubscription(
  customerId: string,
  c: CustomerDef,
  priceIdByPlan: Map<string, string>
): Promise<void> {
  if (c.plan === "free" || c.payment_behavior === "churned") return;

  const priceId = priceIdByPlan.get(c.plan);
  if (!priceId || priceId === "free") return;

  // Date de début de l'abonnement (dans le passé)
  const subStart = daysAgo(c.sub_days_ago);

  try {
    await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId, quantity: Math.max(c.seats, 1) }],
      // backdate_start_date crée le sub avec une date de début passée (test mode)
      backdate_start_date: subStart,
      // Pas de paiement immédiat (test) — on évite les erreurs de carte
      collection_method: "send_invoice",
      days_until_due: 30,
      metadata: {
        sentio_seed: "true",
        churn_risk: c.churn_risk,
        payment_behavior: c.payment_behavior,
      },
    });
  } catch {
    // Fallback sans backdate si non supporté
    await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId, quantity: Math.max(c.seats, 1) }],
      collection_method: "send_invoice",
      days_until_due: 30,
      metadata: {
        sentio_seed: "true",
        churn_risk: c.churn_risk,
      },
    });
  }
}

// ─── ÉTAPE 4 : Créer une facture impayée ─────────────────────────────────────

async function createOverdueInvoice(customerId: string, c: CustomerDef): Promise<void> {
  if (!c.overdue_invoice) return;

  const plan = planConfig(c.plan);
  if (plan.price_cents === 0) return;

  try {
    // Crée une facture manuelle en retard
    const invoice = await stripe.invoices.create({
      customer: customerId,
      collection_method: "send_invoice",
      days_until_due: 0, // échue immédiatement
      metadata: {
        sentio_seed: "true",
        sentio_overdue: "true",
      },
    });

    // Ajoute une ligne de facturation
    await stripe.invoiceItems.create({
      customer: customerId,
      invoice: invoice.id,
      amount: plan.price_cents,
      currency: "eur",
      description: `Sentio AI — ${plan.name} (impayée)`,
    });

    // Finalise la facture (passe en "open")
    await stripe.invoices.finalizeInvoice(invoice.id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠️  Facture impayée non créée pour ${c.name}: ${msg}`);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("════════════════════════════════════════════════════════════");
  console.log("  Sentio AI — Seed 150 comptes démo Stripe");
  console.log("════════════════════════════════════════════════════════════");
  console.log(`  Clé Stripe : ${STRIPE_SECRET_KEY.slice(0, 14)}...`);
  console.log(`  Mode       : TEST uniquement`);
  console.log(`  Comptes    : ${CUSTOMERS.length}`);
  console.log("────────────────────────────────────────────────────────────\n");

  // Étape 1 — Produits & Prix
  const priceIdByPlan = await ensureProductsAndPrices();

  // Étape 2 — Clients
  console.log(`\n👥 Création de ${CUSTOMERS.length} clients...\n`);

  const results: { name: string; id: string; status: "ok" | "error"; error?: string }[] = [];
  let ok = 0;
  let ko = 0;

  for (let i = 0; i < CUSTOMERS.length; i++) {
    const c = CUSTOMERS[i];
    const idx = String(i + 1).padStart(3, "0");

    try {
      // 1. Client
      const customerId = await createCustomer(c);
      await sleep(100);

      // 2. Abonnement
      await createSubscription(customerId, c, priceIdByPlan);
      await sleep(100);

      // 3. Facture impayée si applicable
      await createOverdueInvoice(customerId, c);
      await sleep(80);

      const tag =
        c.payment_behavior === "churned" ? "🔴 churned" :
        c.churn_risk === "high" ? "🟠 high risk" :
        c.churn_risk === "medium" ? "🟡 medium" :
        "🟢 healthy";

      console.log(
        `  ✅ [${idx}] ${c.name.padEnd(30)} ${customerId}  ${c.plan.padEnd(12)} ${tag}`
      );

      results.push({ name: c.name, id: customerId, status: "ok" });
      ok++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ [${idx}] ${c.name} → ERREUR: ${msg}`);
      results.push({ name: c.name, id: "", status: "error", error: msg });
      ko++;
    }
  }

  // ─── Résumé ────────────────────────────────────────────────────────────────

  const byPlan = CUSTOMERS.reduce((acc, c) => {
    acc[c.plan] = (acc[c.plan] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const withOverdue = CUSTOMERS.filter((c) => c.overdue_invoice).length;
  const churned = CUSTOMERS.filter((c) => c.payment_behavior === "churned").length;
  const nouveaux = CUSTOMERS.filter((c) => c.created_days_ago <= 30).length;

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`  ✅ ${ok} compte(s) créé(s)   ❌ ${ko} erreur(s)`);
  console.log("────────────────────────────────────────────────────────────");
  console.log(`  Distribution des plans :`);
  for (const [plan, count] of Object.entries(byPlan)) {
    console.log(`    ${plan.padEnd(12)} ${count} comptes`);
  }
  console.log(`  Nouveaux (< 30j)    : ${nouveaux}`);
  console.log(`  Factures impayées   : ${withOverdue}`);
  console.log(`  Churned             : ${churned}`);
  console.log("════════════════════════════════════════════════════════════\n");

  console.log("💡 Prochaine étape :");
  console.log("   POST /sync-stripe  { sync_type: 'full_sync' }");
  console.log("   pour importer tous ces comptes dans Sentio.\n");
}

main().catch((err) => {
  console.error("\n💥 Erreur fatale :", err.message);
  process.exit(1);
});
