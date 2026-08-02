// ============================================================
// Chantier C — Catalogue des tiers d'abonnement Sentio (V1)
//
// Source unique de vérité pour le gating (accounts trackés) et pour ce
// que renvoie /subscription-status au frontend (pricing/upgrade UI) —
// pas de nombres dupliqués/scattered ailleurs dans la codebase.
//
// Ne pas confondre avec stripe_product_mappings.plan_tier
// (starter/growth/enterprise) : cette table-là mappe les Price ID
// Stripe du COMPTE CLIENT connecté vers un tier utilisé pour le
// scoring (seat_limit) — un concept par-org, orthogonal. Ici il s'agit
// du plan d'abonnement de Sentio elle-même (organizations.plan_type),
// facturé via le compte Stripe de Sentio (STRIPE_SECRET_KEY),
// distinct du compte Stripe de chaque client connecté en OAuth
// (Vault, stripe-oauth-callback).
// ============================================================

export type SubscriptionTierKey = 'free' | 'growth' | 'scale' | 'enterprise'

export interface SubscriptionTier {
  key: SubscriptionTierKey
  display_name: string
  // null = tarif sur devis (Enterprise) — jamais de Stripe Checkout pour ce tier
  price_cents_monthly: number | null
  // null = pas de plafond (Enterprise)
  max_accounts: number | null
  cta: 'self_serve' | 'contact_sales'
  // Nom de la variable d'env contenant le Stripe Price ID de ce tier
  // (résolu au moment de créer la Checkout Session — jamais hardcodé,
  // diffère entre environnements test/prod). null si le tier n'a pas
  // de flow Checkout (Free : rien à payer, Enterprise : contact_sales).
  stripe_price_id_env: string | null
}

export const SUBSCRIPTION_TIERS: SubscriptionTier[] = [
  {
    key: 'free',
    display_name: 'Free',
    price_cents_monthly: 0,
    max_accounts: 30,
    cta: 'self_serve',
    stripe_price_id_env: null,
  },
  {
    key: 'growth',
    display_name: 'Growth',
    price_cents_monthly: 12900,
    max_accounts: 200,
    cta: 'self_serve',
    stripe_price_id_env: 'STRIPE_PRICE_ID_GROWTH',
  },
  {
    key: 'scale',
    display_name: 'Scale',
    price_cents_monthly: 34900,
    max_accounts: 750,
    cta: 'self_serve',
    stripe_price_id_env: 'STRIPE_PRICE_ID_SCALE',
  },
  {
    key: 'enterprise',
    display_name: 'Enterprise',
    price_cents_monthly: null,
    max_accounts: null,
    cta: 'contact_sales',
    stripe_price_id_env: null,
  },
]

const TIERS_BY_KEY = new Map(SUBSCRIPTION_TIERS.map((t) => [t.key, t]))

export function isSubscriptionTierKey(value: string | null | undefined): value is SubscriptionTierKey {
  return value !== null && value !== undefined && TIERS_BY_KEY.has(value as SubscriptionTierKey)
}

// Fallback 'free' si la valeur est absente/inconnue (organizations.plan_type
// est nullable et peut contenir une valeur legacy hors du CHECK actuel sur
// des lignes anciennes non re-validées).
export function getTier(planType: string | null | undefined): SubscriptionTier {
  if (isSubscriptionTierKey(planType)) return TIERS_BY_KEY.get(planType)!
  return TIERS_BY_KEY.get('free')!
}

export function isOverAccountLimit(accountsCount: number, tier: SubscriptionTier): boolean {
  if (tier.max_accounts === null) return false
  return accountsCount > tier.max_accounts
}

export function resolveStripePriceId(tier: SubscriptionTier): string | null {
  if (!tier.stripe_price_id_env) return null
  return Deno.env.get(tier.stripe_price_id_env) ?? null
}

export function findTierByStripePriceId(priceId: string): SubscriptionTier | null {
  for (const tier of SUBSCRIPTION_TIERS) {
    if (resolveStripePriceId(tier) === priceId) return tier
  }
  return null
}
