// ============================================================
// Edge Function : stripe-product-mappings-api
// Gestion du mapping stripe_price_id → plan_tier + seat_limit.
// Chaque organisation configure ce mapping une fois via l'UI ;
// sync-stripe l'utilise à chaque run pour enrichir les accounts.
//
// CONTRAT API
// ──────────────────────────────────────────────────────────
//
// GET /stripe-product-mappings-api
//   Response 200 :
//     { mappings: StripeProductMapping[], total: number }
//   Champ `in_use: boolean` indique si ce price_id est actuellement
//   utilisé dans un abonnement actif ou trialing de l'org.
//
// PUT /stripe-product-mappings-api
//   Body :
//     {
//       stripe_price_id: string,
//       plan_tier: 'starter' | 'growth' | 'enterprise' | null,
//       seat_limit: number | null,
//       unlimited_seats: boolean,
//       stripe_product_name?: string,
//       stripe_price_label?: string
//     }
//   Si unlimited_seats = true : seat_limit est ignoré et stocké NULL.
//   Response 200 : { mapping: StripeProductMapping }
//
// GET /stripe-product-mappings-api/prices-from-stripe
//   Appelle l'API Stripe de l'org pour lister les prices actifs.
//   Response 200 :
//     {
//       prices: Array<{
//         stripe_price_id: string,
//         stripe_product_name: string,
//         stripe_price_label: string,
//         currency: string,
//         unit_amount: number,
//         recurring_interval: 'month' | 'year',
//         already_mapped: boolean
//       }>
//     }
//
// Auth : JWT utilisateur vérifié dans le code (ES256 via verifyUserAuth)
// ============================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCors } from '../_shared/cors.ts'
import { createServiceClient, errorResponse, jsonResponse } from '../_shared/supabase-client.ts'
import { verifyUserAuth, AuthError } from '../_shared/auth.ts'
import { fetchWithTimeout } from '../_shared/fetch-with-timeout.ts'
import { withSentry } from '../_shared/sentry.ts'

const STRIPE_API_BASE = 'https://api.stripe.com/v1'
const STRIPE_TIMEOUT_MS = 15000
const VALID_PLAN_TIERS = ['starter', 'growth', 'enterprise'] as const
type PlanTier = typeof VALID_PLAN_TIERS[number]

// ── Types ─────────────────────────────────────────────────────

interface StripeProductObject {
  id: string
  name: string
}

interface StripePrice {
  id: string
  active: boolean
  currency: string
  unit_amount: number | null
  recurring: { interval: 'month' | 'year'; interval_count: number } | null
  product: StripeProductObject | string | null
}

interface StripePriceListResponse {
  object: 'list'
  data: StripePrice[]
  has_more: boolean
}

interface PutBody {
  stripe_price_id?: unknown
  plan_tier?: unknown
  seat_limit?: unknown
  unlimited_seats?: unknown
  stripe_product_name?: unknown
  stripe_price_label?: unknown
}

// ── Entrypoint ────────────────────────────────────────────────

Deno.serve(withSentry('stripe-product-mappings-api', async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  let auth
  try {
    auth = await verifyUserAuth(req)
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.message, err.status)
    return errorResponse('Authentication failed', 401)
  }

  let supabase
  try {
    supabase = createServiceClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', function_name: 'stripe-product-mappings-api', message: msg }))
    return errorResponse('Server configuration error', 500)
  }

  const orgId = auth.organizationId
  const url = new URL(req.url)
  const isPricesEndpoint = url.pathname.endsWith('/prices-from-stripe')

  if (req.method === 'GET' && isPricesEndpoint) {
    return handlePricesFromStripe(supabase, orgId)
  }

  switch (req.method) {
    case 'GET':
      return handleList(supabase, orgId)
    case 'PUT':
      return handleUpsert(supabase, req, orgId)
    default:
      return errorResponse('Method not allowed', 405)
  }
}))

// ── GET liste des mappings ────────────────────────────────────

async function handleList(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
): Promise<Response> {
  const [mappingsRes, subsRes] = await Promise.all([
    supabase
      .from('stripe_product_mappings')
      .select('id, organization_id, stripe_price_id, stripe_product_name, stripe_price_label, plan_tier, seat_limit, unlimited_seats, created_at, updated_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false }),
    supabase
      .from('subscriptions')
      .select('stripe_price_id')
      .eq('organization_id', orgId)
      .in('status', ['active', 'trialing']),
  ])

  if (mappingsRes.error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'stripe-product-mappings-api', organization_id: orgId, message: mappingsRes.error.message }))
    return errorResponse('Failed to fetch mappings', 500)
  }

  const activePriceIds = new Set(
    (subsRes.data ?? []).map((s: { stripe_price_id: string | null }) => s.stripe_price_id).filter(Boolean),
  )

  const mappings = (mappingsRes.data ?? []).map((m: Record<string, unknown>) => ({
    ...m,
    in_use: activePriceIds.has(m.stripe_price_id as string),
  }))

  return jsonResponse({ mappings, total: mappings.length })
}

// ── PUT upsert d'un mapping ───────────────────────────────────

async function handleUpsert(
  supabase: ReturnType<typeof createServiceClient>,
  req: Request,
  orgId: string,
): Promise<Response> {
  let body: PutBody
  try {
    body = await req.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  // Validation stripe_price_id
  if (!body.stripe_price_id || typeof body.stripe_price_id !== 'string' || body.stripe_price_id.trim().length === 0) {
    return errorResponse('stripe_price_id is required', 400)
  }
  const stripePriceId = body.stripe_price_id.trim()

  // Validation plan_tier
  if (body.plan_tier !== null && body.plan_tier !== undefined) {
    if (!VALID_PLAN_TIERS.includes(body.plan_tier as PlanTier)) {
      return errorResponse(`plan_tier must be null or one of: ${VALID_PLAN_TIERS.join(', ')}`, 400)
    }
  }
  const planTier = (body.plan_tier ?? null) as PlanTier | null

  // Validation unlimited_seats
  const unlimitedSeats = body.unlimited_seats === true

  // Validation seat_limit — ignoré si unlimited_seats = true
  let seatLimit: number | null = null
  if (!unlimitedSeats) {
    if (body.seat_limit !== null && body.seat_limit !== undefined) {
      if (typeof body.seat_limit !== 'number' || !Number.isInteger(body.seat_limit) || body.seat_limit <= 0) {
        return errorResponse('seat_limit must be a positive integer or null', 400)
      }
      seatLimit = body.seat_limit
    }
  }

  // Champs optionnels d'affichage
  const stripeProductName = (typeof body.stripe_product_name === 'string' ? body.stripe_product_name.trim() : null) || null
  const stripePriceLabel = (typeof body.stripe_price_label === 'string' ? body.stripe_price_label.trim() : null) || null

  const { data, error } = await supabase
    .from('stripe_product_mappings')
    .upsert(
      {
        organization_id: orgId,
        stripe_price_id: stripePriceId,
        plan_tier: planTier,
        seat_limit: seatLimit,
        unlimited_seats: unlimitedSeats,
        stripe_product_name: stripeProductName,
        stripe_price_label: stripePriceLabel,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,stripe_price_id' },
    )
    .select('id, organization_id, stripe_price_id, stripe_product_name, stripe_price_label, plan_tier, seat_limit, unlimited_seats, created_at, updated_at')
    .maybeSingle()

  if (error) {
    console.error(JSON.stringify({ level: 'error', function_name: 'stripe-product-mappings-api', organization_id: orgId, message: error.message }))
    return errorResponse('Failed to upsert mapping', 500)
  }

  return jsonResponse({ mapping: data })
}

// ── GET prices depuis Stripe ──────────────────────────────────

async function handlePricesFromStripe(
  supabase: SupabaseClient,
  orgId: string,
): Promise<Response> {
  // Lire la clé Stripe de l'org (pattern identique à sync-stripe)
  const { data: org } = await supabase
    .from('organizations')
    .select('stripe_api_key')
    .eq('id', orgId)
    .maybeSingle()

  const stripeApiKey: string = org?.stripe_api_key ?? Deno.env.get('STRIPE_SECRET_KEY') ?? ''
  if (!stripeApiKey) {
    return errorResponse('Stripe key not configured. Add your key under Integrations → Stripe.', 400)
  }

  // Récupérer les mappings existants pour le flag already_mapped
  const { data: existingMappings } = await supabase
    .from('stripe_product_mappings')
    .select('stripe_price_id')
    .eq('organization_id', orgId)

  const mappedPriceIds = new Set(
    (existingMappings ?? []).map((m: { stripe_price_id: string }) => m.stripe_price_id),
  )

  // Paginer les prices Stripe actifs avec expand product
  const prices: ReturnType<typeof formatStripePrice>[] = []
  let hasMore = true
  let startingAfter: string | undefined

  while (hasMore) {
    const params = new URLSearchParams({ active: 'true', limit: '100', 'expand[]': 'data.product' })
    if (startingAfter) params.set('starting_after', startingAfter)

    let page: StripePriceListResponse
    try {
      const resp = await fetchWithTimeout(
        `${STRIPE_API_BASE}/prices?${params.toString()}`,
        { headers: { Authorization: `Bearer ${stripeApiKey}` } },
        STRIPE_TIMEOUT_MS,
      )
      if (!resp.ok) {
        const err = await resp.text()
        console.error(JSON.stringify({ level: 'error', function_name: 'stripe-product-mappings-api', message: `Stripe prices → ${resp.status}: ${err}` }))
        return errorResponse('Failed to fetch Stripe prices', 502)
      }
      page = await resp.json() as StripePriceListResponse
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(JSON.stringify({ level: 'error', function_name: 'stripe-product-mappings-api', message: `Stripe fetch failed: ${msg}` }))
      return errorResponse('Error communicating with Stripe', 502)
    }

    for (const price of page.data) {
      const formatted = formatStripePrice(price)
      if (formatted) {
        prices.push({ ...formatted, already_mapped: mappedPriceIds.has(price.id) })
      }
    }

    hasMore = page.has_more
    if (hasMore && page.data.length > 0) {
      startingAfter = page.data[page.data.length - 1].id
    }
  }

  return jsonResponse({ prices })
}

// ── Helper : formatage d'un price Stripe ─────────────────────

function formatStripePrice(price: StripePrice): {
  stripe_price_id: string
  stripe_product_name: string
  stripe_price_label: string
  currency: string
  unit_amount: number
  recurring_interval: 'month' | 'year'
} | null {
  // On n'expose que les prices récurrents (pas les one-shot)
  if (!price.recurring) return null

  const product = typeof price.product === 'object' && price.product !== null
    ? price.product as StripeProductObject
    : null
  const productName = product?.name ?? price.id

  const amountEur = (price.unit_amount ?? 0) / 100
  const interval = price.recurring.interval === 'year' ? 'an' : 'mois'
  const priceLabel = `${amountEur}${price.currency.toUpperCase() === 'EUR' ? '€' : ` ${price.currency.toUpperCase()}`}/${interval}`

  return {
    stripe_price_id: price.id,
    stripe_product_name: productName,
    stripe_price_label: priceLabel,
    currency: price.currency,
    unit_amount: price.unit_amount ?? 0,
    recurring_interval: price.recurring.interval,
  }
}
