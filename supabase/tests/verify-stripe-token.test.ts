import { describe, it, expect } from 'vitest'

// Mirror de verify-stripe-token/index.ts — même convention que
// sync-stripe-key-resolution.test.ts (imports jsr: en position valeur,
// non résolvables par Vitest).
//
// BUG CORRIGÉ (2026-08-17)
// ──────────────────────────────────────────────────────────
// L'UPDATE organizations de ce endpoint ne posait jamais `stripe_api_key` —
// seulement `stripe_connected`/`stripe_connection_method`. C'est pourtant
// la colonne que `sync-stripe` lit réellement (`orgsToSync[0].stripe_api_key`,
// cf. sync-stripe-key-resolution.test.ts). L'écriture Vault censée porter la
// clé (`vault_create_secret`) échoue systématiquement — cette RPC n'existe
// pas en base (confirmé en direct via pg_proc ; seul `vault_store_secret`
// existe, nom et signature différents) — mais cet échec était déjà non
// bloquant par design ("proceeding without"), donc silencieux.
//
// Effet observé sur un signup réel (org "naimaallies", 2026-08-17 14:37 UTC) :
// verify-stripe-token répond succès, sync-stripe est bien déclenché et
// résout l'org (log "orgs_resolved", count:1), puis refuse immédiatement
// (`stripe_api_key` est null) — avant même d'écrire une ligne data_syncs.
// Le frontend reste bloqué indéfiniment sur "Building cohorts", sans jamais
// voir cette raison — la seule chose montrée après 90s est un texte
// générique client-side ("check your Stripe permissions"), sans rapport
// avec la cause réelle.
//
// Correctif : `stripe_api_key` ajouté à l'UPDATE, même colonne et même
// pattern que update-stripe-connection/index.ts (chemin Settings), qui
// l'écrit déjà avec succès.

interface OrgUpdatePayload {
  stripe_api_key: string
  stripe_connected: boolean
  stripe_connection_method: string
}

/** Mirror du payload construit par verify-stripe-token après validation Stripe réussie. */
function buildOrgUpdatePayload(stripeApiKey: string): OrgUpdatePayload {
  return {
    stripe_api_key: stripeApiKey,
    stripe_connected: true,
    stripe_connection_method: 'api_key',
  }
}

/** Mirror de la résolution de clé côté sync-stripe (lecture de la même colonne). */
function resolveApiKeyForSync(org: { stripe_api_key: string | null }): string | null {
  return org.stripe_api_key ?? null
}

// Valeurs de test volontairement non conformes au charset d'une vraie clé
// Stripe (mots lisibles + underscores, pas de suffixe base62 dense) — même
// convention que sync-stripe-key-resolution.test.ts, pour ne pas déclencher
// la détection de secrets de GitHub sur un simple fixture de test.
const FIXTURE_KEY_TEST = 'sk_test_fixture_not_a_real_key_do_not_use'
const FIXTURE_KEY_LIVE = 'sk_live_fixture_not_a_real_key_do_not_use'
const FIXTURE_KEY_RESTRICTED = 'rk_test_fixture_not_a_real_key_do_not_use'

describe('verify-stripe-token — the key sync-stripe reads is actually written', () => {
  it('REGRESSION: the org update payload includes stripe_api_key', () => {
    const payload = buildOrgUpdatePayload(FIXTURE_KEY_TEST)
    expect(payload.stripe_api_key).toBe(FIXTURE_KEY_TEST)
  })

  it('REGRESSION: sync-stripe resolves a real key from the org this payload produced', () => {
    // Round-trip: what verify-stripe-token writes is exactly what
    // sync-stripe's own key resolution (sync-stripe-key-resolution.test.ts)
    // reads — the two must agree on the column, not just each be internally
    // consistent.
    const payload = buildOrgUpdatePayload(FIXTURE_KEY_LIVE)
    const orgAfterUpdate = { stripe_api_key: payload.stripe_api_key }
    expect(resolveApiKeyForSync(orgAfterUpdate)).toBe(FIXTURE_KEY_LIVE)
  })

  it('never leaves stripe_api_key null after a successful verification', () => {
    const payload = buildOrgUpdatePayload(FIXTURE_KEY_RESTRICTED)
    expect(payload.stripe_api_key).not.toBeNull()
    expect(payload.stripe_api_key.length).toBeGreaterThan(0)
  })
})
