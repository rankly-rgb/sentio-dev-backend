import { describe, it, expect } from 'vitest'

// Mirror de la résolution de clé dans sync-stripe/index.ts — même convention
// que sync-stripe-quota.test.ts (imports jsr: en position valeur, non
// résolvables par Vitest).
//
// BUG CORRIGÉ (audit sync 2026-08-15)
// ──────────────────────────────────────────────────────────
// Le filtre d'orgs acceptait une org dès que STRIPE_SECRET_KEY existait dans
// l'environnement, et la résolution de clé repliait dessus :
//
//   orgsToSync = data.filter((o) => o.stripe_api_key || Deno.env.get('STRIPE_SECRET_KEY'))
//   const apiKey = orgsToSync[0].stripe_api_key ?? Deno.env.get('STRIPE_SECRET_KEY')
//
// Or STRIPE_SECRET_KEY est la clé du compte Stripe de Sentio elle-même
// (OAuth callback + Checkout Sessions, cf. CLAUDE.md), jamais celle d'un
// client. Toute org sans clé propre importait donc les customers de Sentio
// comme si c'étaient les siens — contamination inter-tenants silencieuse.
//
// Aggravant : `disconnect` (update-stripe-connection) met stripe_api_key à
// null. Se déconnecter ne coupait donc pas le sync, ça le rebranchait sur le
// compte de Sentio.
//
// Mesuré sur le projet dev avant correctif : 9 orgs actives sans clé propre,
// synchronisées chaque nuit à 02:00, toutes avec exactement le même nombre de
// comptes — signature d'un import du même compte Stripe partout.

const SENTIO_OWN_KEY = 'sk_live_sentio_own_account_key'

interface Org {
  id: string
  stripe_api_key: string | null
}

/** Filtre du mode cron (toutes les orgs). */
function selectOrgsToSync(orgs: Org[]): Org[] {
  return orgs.filter((o) => Boolean(o.stripe_api_key))
}

/** Résolution de clé du chemin org unique. `null` ⇒ refus (500). */
function resolveApiKey(org: Org): string | null {
  return org.stripe_api_key ?? null
}

describe('sync-stripe — an org never syncs against Sentio own Stripe account', () => {
  const withKey: Org = { id: 'org-connected', stripe_api_key: 'sk_test_client_key_xxxxxxxxxxxx' }
  const withoutKey: Org = { id: 'org-no-key', stripe_api_key: null }

  it('REGRESSION: an org with no key of its own is excluded from the cron sweep', () => {
    // Avant le correctif, la présence de STRIPE_SECRET_KEY suffisait à
    // l'inclure — c'est ce qui faisait tourner 9 orgs chaque nuit.
    expect(selectOrgsToSync([withKey, withoutKey])).toEqual([withKey])
  })

  it('REGRESSION: a disconnected org (key nulled by disconnect) stops syncing', () => {
    const justDisconnected: Org = { id: 'org-x', stripe_api_key: null }
    expect(selectOrgsToSync([justDisconnected])).toEqual([])
    expect(resolveApiKey(justDisconnected)).toBeNull()
  })

  it('REGRESSION: the single-org path refuses instead of falling back', () => {
    // Ce chemin ne passe pas par le filtre : il a besoin de sa propre garde.
    const resolved = resolveApiKey(withoutKey)
    expect(resolved).toBeNull()
    expect(resolved).not.toBe(SENTIO_OWN_KEY)
  })

  it('an org with its own key still syncs, with its own key', () => {
    expect(resolveApiKey(withKey)).toBe(withKey.stripe_api_key)
  })

  it('several keyless orgs are all excluded — none inherits a shared key', () => {
    const keyless = ['a', 'b', 'c'].map((id) => ({ id, stripe_api_key: null }))
    expect(selectOrgsToSync([...keyless, withKey])).toEqual([withKey])
  })
})
