# Implémente la connexion Stripe par Clé API

## Objectif

Sur la page Intégrations (`/settings/integrations`), la carte Stripe Connect montre actuellement "Connexion Stripe expirée" avec un bouton "Reconnecter" qui utilise OAuth Connect. Ce flux OAuth est bloquant car il nécessite un `ca_xxx` Stripe Connect difficile à obtenir.

**Tu dois ajouter une deuxième méthode de connexion : coller une clé API Stripe secrète.**

Le backend est déjà prêt. Tu n'as rien à modifier côté backend.

---

## API Backend (déjà déployée)

### Connecter via clé API

```
POST {NEXT_PUBLIC_SUPABASE_URL}/functions/v1/integration-oauth/stripe/api-key
Authorization: Bearer <JWT>
Content-Type: application/json

{ "api_key": "sk_live_51T65tb..." }
```

**Succès (200)** :
```json
{
  "success": true,
  "provider": "stripe",
  "method": "api_key",
  "account_id": "acct_1T65tbGaqS0J01nL",
  "account_name": "Mon Entreprise SAS",
  "status": "connected"
}
```

**Erreurs** :
- `400` — `{ "error": "api_key requis" }` ou `{ "error": "Clé publishable (pk_) non acceptée..." }` ou `{ "error": "Clé API Stripe invalide ou revoquee" }`
- `409` — `{ "error": "Stripe est deja connecte. Revoquez d'abord l'integration existante." }`
- `401` — Clé Stripe invalide
- `502` — Stripe injoignable

### Statut (déjà utilisé par le frontend)

```
GET {NEXT_PUBLIC_SUPABASE_URL}/functions/v1/integration-oauth/status
Authorization: Bearer <JWT>
```

Retourne maintenant un nouveau champ `integration_method` :
```json
{
  "stripe": {
    "provider": "stripe",
    "connected": true,
    "provider_account_id": "acct_xxx",
    "scopes": ["read_only"],
    "status": "active",
    "integration_method": "api_key"   // ← NOUVEAU : "oauth" ou "api_key"
  },
  "hubspot": { ... }
}
```

### Révoquer (existant, inchangé)

```
POST {NEXT_PUBLIC_SUPABASE_URL}/functions/v1/integration-oauth/revoke
Authorization: Bearer <JWT>
Content-Type: application/json

{ "provider": "stripe" }
```

---

## Ce que tu dois modifier

### 1. Carte Stripe sur la page Intégrations

Quand Stripe n'est **PAS connecté**, remplace le simple bouton "Reconnecter" par deux options :

**Option A — Stripe Connect (OAuth)** : le bouton existant "Connecter via Stripe Connect" (garde le code actuel).

**Option B — Clé API Stripe** (NOUVEAU) :
- Un `<input type="password">` avec placeholder `sk_live_...`
- Un bouton "Connecter avec ma clé API"
- Un texte d'aide : "Collez votre Secret Key depuis Dashboard Stripe → Développeurs → Clés API"
- Un avertissement : "Ne collez jamais votre clé publique (pk_). Seule la Secret Key (sk_) est acceptée."

**Layout suggéré** : deux onglets ou deux sections radio dans la carte Stripe, par exemple :
```
[ Stripe Connect ]  [ Clé API ]
```

### 2. Validation côté client (avant soumission)

Applique cette validation sur le champ input avant d'envoyer le POST :

```typescript
function validateStripeKey(key: string): { valid: boolean; error?: string } {
  const trimmed = key.trim()
  if (!trimmed) return { valid: false, error: 'Clé API requise' }
  if (trimmed.startsWith('pk_')) {
    return { valid: false, error: 'Utilisez la Secret Key (sk_), pas la clé publique (pk_)' }
  }
  if (!/^(sk_live_|sk_test_|rk_live_|rk_test_)/.test(trimmed)) {
    return { valid: false, error: 'La clé doit commencer par sk_live_ ou sk_test_' }
  }
  if (trimmed.length < 30) {
    return { valid: false, error: 'Clé trop courte' }
  }
  return { valid: true }
}
```

Affiche l'erreur de validation sous le champ input en rouge.

### 3. Appel API

```typescript
async function connectStripeApiKey(apiKey: string) {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()

  const response = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/integration-oauth/stripe/api-key`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session?.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ api_key: apiKey }),
    }
  )

  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Erreur connexion Stripe')
  return data
}
```

### 4. Gestion des états UI

**Pendant la connexion** :
- Désactiver le bouton + afficher un spinner
- Message : "Vérification de la clé en cours..."

**Succès** :
- Toast : "Stripe connecté ! Synchronisation en cours..."
- Afficher `account_name` retourné par l'API
- Rafraîchir le statut (re-fetch GET /status)

**Erreur 409** :
- Message : "Stripe est déjà connecté. Révoquez d'abord."

**Erreur 400/401** :
- Afficher le message d'erreur du backend sous le champ input
- Ne pas effacer le champ (l'utilisateur corrige sa clé)

**Erreur 502** :
- Message : "Impossible de contacter Stripe. Réessayez dans quelques instants."

### 5. Affichage quand Stripe est connecté

Utilise le nouveau champ `integration_method` du GET /status pour afficher un badge :
- `integration_method: "oauth"` → badge "Stripe Connect"
- `integration_method: "api_key"` → badge "Clé API"

Le bouton "Déconnecter" (revoke) est identique pour les deux méthodes.

### 6. Sécurité

- Le champ input DOIT être `type="password"` (avec toggle visibility optionnel)
- Ne JAMAIS stocker la clé dans localStorage, sessionStorage, ou un state React persistent
- La clé ne transite que dans le POST et est immédiatement stockée chiffrée dans Vault côté backend
- Après connexion réussie, vider le champ input

---

## Résumé des fichiers à modifier

1. **Composant carte Stripe** sur `/settings/integrations` — ajouter onglet/section "Clé API" avec input + bouton
2. **Fonction API** — ajouter `connectStripeApiKey()` (ou l'intégrer dans le hook/service existant)
3. **Affichage statut** — utiliser `integration_method` pour le badge OAuth vs API Key
