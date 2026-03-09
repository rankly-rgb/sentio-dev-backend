# Prompt Frontend — Intégration Stripe par Clé API

## Contexte

Le backend Sentio AI supporte désormais **deux méthodes** pour connecter un compte Stripe :
1. **OAuth Connect** (existant) — flux authorize/callback via Stripe Connect
2. **Clé API directe** (NOUVEAU) — l'utilisateur colle sa Secret Key Stripe

L'OAuth Connect nécessite un `ca_xxx` (Client ID Stripe Connect) obtenu après onboarding Stripe, ce qui bloque beaucoup d'utilisateurs. La clé API directe est une alternative simple et immédiate.

**Repo backend** : `sentio-dev-backend` (branche `feat/export-playbook-accounts`)
**Repo frontend** : celui dans lequel tu travailles

---

## Ce qui a changé côté backend

### 1. Nouvelle colonne DB

```sql
ALTER TABLE organization_integrations
  ADD COLUMN integration_method TEXT NOT NULL DEFAULT 'oauth';
-- CHECK: ('oauth', 'api_key')
```

### 2. Nouvel endpoint : POST /stripe/api-key

**URL** : `{SUPABASE_URL}/functions/v1/integration-oauth/stripe/api-key`

**Headers** :
```
Authorization: Bearer <JWT>
Content-Type: application/json
```

**Body** :
```json
{
  "stripe_api_key": "sk_live_51T65tb..."
}
```

**Réponse succès (200)** :
```json
{
  "success": true,
  "account_id": "acct_1T65tbGaqS0J01nL",
  "account_name": "Mon Entreprise SAS",
  "integration_method": "api_key",
  "message": "Stripe connecté via clé API. Synchronisation initiale lancée."
}
```

**Réponses erreur** :

| Status | Cas | Body |
|--------|-----|------|
| 400 | Clé manquante | `{ "error": "stripe_api_key is required" }` |
| 400 | Format invalide | `{ "error": "Invalid Stripe API key: <détail>" }` |
| 400 | Clé invalide (Stripe rejette) | `{ "error": "Invalid Stripe API key: <message Stripe>" }` |
| 409 | Déjà connecté | `{ "error": "Stripe is already connected (method: oauth). Revoke first." }` |
| 401 | JWT invalide | `{ "error": "Unauthorized" }` |

### 3. Endpoints existants inchangés

- `GET /integration-oauth/stripe/status` — retourne désormais aussi `integration_method: "api_key" | "oauth"`
- `POST /integration-oauth/stripe/revoke` — fonctionne pour les deux méthodes
- `GET /integration-oauth/stripe/authorize` — inchangé (OAuth Connect uniquement)

### 4. Validation de la clé API (côté backend)

Le backend valide :
- Format : doit commencer par `sk_live_`, `sk_test_`, `rk_live_` ou `rk_test_`
- Rejet des clés publishables (`pk_`)
- Longueur minimum : 30 caractères
- Appel Stripe `GET /v1/account` pour vérifier que la clé est valide
- La clé est stockée chiffrée dans Supabase Vault (jamais en clair en DB)

---

## Ce qu'il faut implémenter côté frontend

### 1. Modifier la page Intégrations Stripe

Sur la page où l'utilisateur connecte Stripe (probablement `/dashboard/settings/integrations` ou similaire), ajouter **deux options** :

#### Option A — OAuth Connect (existant)
Bouton "Connecter via Stripe Connect" → redirige vers `/integration-oauth/stripe/authorize`

#### Option B — Clé API (NOUVEAU)
- Un champ `<input type="password">` avec placeholder "sk_live_..." ou "sk_test_..."
- Un bouton "Connecter avec ma clé API"
- Validation côté client avant soumission :
  - Doit commencer par `sk_live_`, `sk_test_`, `rk_live_` ou `rk_test_`
  - Rejet `pk_` avec message explicite
  - Longueur >= 30 caractères

#### UX suggérée

```
┌─────────────────────────────────────────────────┐
│  Connecter Stripe                               │
│                                                 │
│  ○ Stripe Connect (recommandé)                  │
│    [Connecter via Stripe Connect]               │
│                                                 │
│  ○ Clé API secrète                              │
│    Collez votre Secret Key depuis le            │
│    Dashboard Stripe → Développeurs → Clés API   │
│                                                 │
│    [••••••••••••••••••••••••••••]                │
│    [Connecter avec ma clé API]                  │
│                                                 │
│  ⚠ Ne partagez jamais votre clé publique (pk_). │
│    Seule la Secret Key (sk_) est acceptée.      │
└─────────────────────────────────────────────────┘
```

### 2. Gestion des états

#### Pendant la connexion
- Désactiver le bouton + spinner
- Message : "Vérification de la clé en cours..."

#### Succès
- Toast/notification : "Stripe connecté ! Synchronisation en cours..."
- Afficher le nom du compte Stripe retourné (`account_name`)
- Rafraîchir le statut de connexion

#### Erreur 409 (déjà connecté)
- Message : "Stripe est déjà connecté. Révoquez d'abord la connexion existante."
- Lien/bouton vers la révocation

#### Erreur 400 (clé invalide)
- Afficher le message d'erreur retourné par le backend
- Ne pas effacer le champ (l'utilisateur peut corriger)

### 3. Affichage du statut de connexion

Quand Stripe est connecté, afficher la méthode utilisée :
- OAuth Connect : "Connecté via Stripe Connect" + badge `OAuth`
- Clé API : "Connecté via clé API" + badge `API Key`

La méthode est disponible dans `GET /integration-oauth/stripe/status` → champ `integration_method`.

### 4. Sécurité

- **JAMAIS** afficher la clé API en clair après soumission (le backend ne la retourne pas)
- Le champ input doit être `type="password"` avec toggle visibility optionnel
- Ne pas stocker la clé dans localStorage/sessionStorage
- La clé ne transite que dans le POST, elle est immédiatement stockée dans Vault côté backend

---

## Appel API — Exemple

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
      body: JSON.stringify({ stripe_api_key: apiKey }),
    }
  )

  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.error || 'Erreur lors de la connexion Stripe')
  }

  return data // { success, account_id, account_name, integration_method }
}
```

## Validation côté client — Exemple

```typescript
function validateStripeKey(key: string): { valid: boolean; error?: string } {
  const trimmed = key.trim()
  if (!trimmed) return { valid: false, error: 'Clé API requise' }
  if (trimmed.startsWith('pk_')) {
    return { valid: false, error: 'Utilisez la Secret Key (sk_), pas la clé publique (pk_)' }
  }
  if (!trimmed.match(/^(sk_live_|sk_test_|rk_live_|rk_test_)/)) {
    return { valid: false, error: 'Format invalide — la clé doit commencer par sk_live_ ou sk_test_' }
  }
  if (trimmed.length < 30) {
    return { valid: false, error: 'Clé trop courte' }
  }
  return { valid: true }
}
```

---

## Résumé des tâches

1. Ajouter le formulaire clé API sur la page intégrations Stripe (input password + bouton)
2. Validation côté client (format sk_/rk_, rejet pk_, longueur)
3. Appel POST `/stripe/api-key` avec gestion erreurs (400, 409, 401)
4. Afficher la méthode de connexion (OAuth vs API Key) dans le statut
5. Toast/notification succès avec nom du compte
6. Sécurité : pas de stockage local de la clé, input type password
