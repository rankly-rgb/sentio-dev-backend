// ============================================================
// stripe-shared-key-testing.ts — bypass TEST UNIQUEMENT permettant de
// connecter la même clé API Stripe à plusieurs organisations.
//
// Contexte (2026-08-20) : pour les tests bêta, Naima veut pouvoir créer
// plusieurs orgs Sentio de test sans provisionner un compte Stripe
// distinct pour chacune. En usage réel, une clé Stripe = un client
// Sentio = une organisation — ce mécanisme ne doit JAMAIS être actif
// dans l'environnement qui sert la cohorte bêta réelle.
//
// Gate : variable d'env ALLOW_SHARED_STRIPE_KEY, absente/false par
// défaut (`isSharedStripeKeyTestingAllowed()` → false). Ne touche
// AUCUNE garantie multi-tenant/RLS — seule la valeur de
// `organizations.stripe_api_key` a le droit d'être identique entre deux
// orgs quand ce flag est actif. `organizations.stripe_account_id`
// (contrainte UNIQUE globale, cf. `_shared/stripe-account-claim.ts`)
// n'est JAMAIS écrit en cas de partage détecté, flag actif ou non — la
// garde applicative/DB sur cette colonne reste intacte, on la
// contourne en ne l'alimentant simplement pas pour la 2e+ org (voir
// call sites dans `update-stripe-connection`/`stripe-oauth-callback`).
//
// Désactivation avant l'ouverture à de vrais bêta-testeurs : ne pas
// définir (ou retirer) `ALLOW_SHARED_STRIPE_KEY` dans les secrets de
// l'Edge Function — comportement par défaut inchangé, aucun code à
// modifier.
// ============================================================

import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export function isSharedStripeKeyTestingAllowed(): boolean {
  return Deno.env.get('ALLOW_SHARED_STRIPE_KEY') === 'true'
}

/**
 * Non-bloquant, n'échoue jamais l'appelant : cherche une AUTRE org qui
 * utilise déjà la même `stripe_api_key`, et trace un warn explicite si
 * trouvée. Tourne indépendamment du flag `ALLOW_SHARED_STRIPE_KEY` —
 * certains chemins de connexion (`verify-stripe-token`) n'ont jamais eu
 * de garde d'unicité sur la clé et permettent donc déjà ce partage; ce
 * log est le seul filet qui rend le partage visible sur ces chemins-là,
 * pour ne jamais le confondre plus tard avec une anomalie de prod.
 */
export async function logSharedStripeKeyIfDetected(
  supabase: SupabaseClient,
  organizationId: string,
  apiKey: string,
  functionName: string,
): Promise<void> {
  try {
    const { data } = await supabase
      .from('organizations')
      .select('id')
      .eq('stripe_api_key', apiKey)
      .neq('id', organizationId)
      .limit(1)
      .maybeSingle()

    if (data?.id) {
      console.warn(JSON.stringify({
        level: 'warn',
        function_name: functionName,
        event: 'shared_stripe_key_detected',
        test_mode_only: true,
        organization_id: organizationId,
        other_organization_id: data.id,
        message: 'Same Stripe API key connected to multiple organizations — expected only under ALLOW_SHARED_STRIPE_KEY testing, never in the real beta cohort.',
      }))
    }
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      function_name: functionName,
      message: `logSharedStripeKeyIfDetected failed: ${err instanceof Error ? err.message : String(err)}`,
    }))
  }
}
