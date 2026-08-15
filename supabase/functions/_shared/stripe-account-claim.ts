// ============================================================
// stripe-account-claim.ts — Garde d'unicité sur organizations.stripe_account_id
//
// `organizations.stripe_account_id` porte une contrainte UNIQUE globale
// (`organizations_stripe_account_id_key`, migration 20260301000002). Cette
// unicité est VOULUE et ne doit pas être levée : `stripe-webhook/index.ts`
// résout l'org d'un event entrant par `.eq('stripe_account_id', ...)` — deux
// orgs sur le même compte Stripe rendraient ce routage ambigu.
//
// Le problème qu'on corrige ici n'est donc pas l'unicité, c'est son absence
// de garde côté applicatif : `update-stripe-connection` et
// `stripe-oauth-callback` écrivaient `stripe_account_id` sans jamais vérifier
// si une autre org le revendiquait déjà. Une collision remontait en 23505 →
// 500 générique ("Failed to update the organization record"), sans que rien
// n'indique à l'utilisateur que son compte Stripe est déjà rattaché ailleurs.
//
// Incident du 2026-08-15 : une clé sk_ valide était refusée en boucle depuis
// Settings → Stripe connection, avec ce 500 opaque. Trois orgs déconnectées
// squattaient encore un `acct_` — voir `releaseStripeAccountClaim` plus bas
// pour la fuite qui les avait produites.
// ============================================================

import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

// Message unique, partagé par les deux chemins de connexion (clé API et
// OAuth) — le frontend l'affiche verbatim (`fetchWithUserJwt.ts`, `data.error`).
export const STRIPE_ACCOUNT_CONFLICT_MESSAGE =
  'This Stripe account is already connected to another organization. Disconnect it there first, then try again.'

export const STRIPE_ACCOUNT_CONFLICT_STATUS = 409

// Code Postgres d'une violation de contrainte unique, propagé tel quel par
// PostgREST dans `error.code`.
const UNIQUE_VIOLATION_CODE = '23505'
const STRIPE_ACCOUNT_CONSTRAINT = 'organizations_stripe_account_id_key'

/**
 * Reconnaît une collision sur `stripe_account_id` à partir de l'erreur
 * PostgREST d'un UPDATE `organizations`.
 *
 * Filet de sécurité derrière `findConflictingOrganization` : la vérification
 * préalable est une lecture suivie d'une écriture, donc TOCTOU-sensible par
 * construction (deux connexions concurrentes du même compte Stripe passent
 * toutes deux la lecture). Seule la contrainte elle-même est atomique — on
 * traduit donc aussi son erreur plutôt que de la laisser filer en 500.
 *
 * Volontairement tolérant sur la forme : `code` est le signal fiable, le
 * nom de contrainte n'est cherché dans le message que pour ne pas confondre
 * avec une autre unicité de la table (`organizations_slug_key` etc.).
 */
export function isStripeAccountConflict(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false
  if (error.code !== UNIQUE_VIOLATION_CODE) return false
  const message = error.message ?? ''
  // Un 23505 sans nom de contrainte lisible est traité comme une collision
  // stripe_account_id : c'est la seule unicité que ces deux chemins peuvent
  // déclencher (ils n'écrivent aucune autre colonne unique).
  if (message === '') return true
  return message.includes(STRIPE_ACCOUNT_CONSTRAINT) || message.includes('stripe_account_id')
}

/**
 * Cherche une AUTRE org revendiquant déjà ce compte Stripe.
 *
 * Retourne l'id de l'org en conflit, ou `null` si le compte est libre (ou
 * déjà détenu par `organizationId` lui-même — se reconnecter au même compte
 * Stripe est un cas parfaitement normal, jamais un conflit).
 *
 * `lookupFailed` distingue "aucun conflit" d'un "je n'ai pas pu vérifier"
 * (S1, no data ≠ neutral data) : sur échec de lecture on laisse la contrainte
 * DB trancher plutôt que de bloquer une connexion légitime sur une panne de
 * lecture.
 */
export async function findConflictingOrganization(
  supabase: SupabaseClient,
  stripeAccountId: string,
  organizationId: string,
): Promise<{ conflictingOrgId: string | null; lookupFailed: boolean }> {
  const { data, error } = await supabase
    .from('organizations')
    .select('id')
    .eq('stripe_account_id', stripeAccountId)
    .neq('id', organizationId)
    .limit(1)
    .maybeSingle()

  if (error) return { conflictingOrgId: null, lookupFailed: true }
  return { conflictingOrgId: data?.id ?? null, lookupFailed: false }
}
