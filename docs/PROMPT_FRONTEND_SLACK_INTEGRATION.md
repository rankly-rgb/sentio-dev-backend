# Prompt Frontend — Connexion Slack par Bot Token

## Contexte backend (deja implemente et deploye)

Le backend Sentio supporte maintenant la connexion Slack par Bot Token, identique au pattern Stripe/HubSpot API Key :

1. **POST /integration-oauth/slack/bot-token** — connecter Slack via Bot Token
   - Body : `{ "bot_token": "xoxb-xxxx" }` ou `{ "slack_bot_token": "xoxb-xxxx" }`
   - Auth : JWT Bearer token Supabase
   - Validation : appel `auth.test` Slack pour verifier le token
   - Reponse succes : `{ success: true, provider: "slack", method: "bot_token", team_id: "T0123XXX", team_name: "Mon Workspace", status: "connected" }`
   - Erreurs :
     - 400 : `bot_token requis` / format invalide (doit commencer par `xoxb-` ou `xoxp-`, min 30 chars)
     - 401 : `Token Slack invalide : invalid_auth`
     - 409 : `Slack est deja connecte. Revoquez d'abord l'integration existante.`
     - 502 : `Impossible de contacter l'API Slack — reessayez`

2. **GET /integration-oauth/status** — retourne le statut des 3 integrations
   - Reponse : `{ stripe: {...}, hubspot: {...}, slack: { connected: boolean, provider_account_id: "T0123XXX", scopes: ["chat:write","channels:read"], status: "active"|"pending", integration_method: "api_key" } }`

3. **POST /integration-oauth/revoke** — revoquer une integration
   - Body : `{ "provider": "slack" }`
   - Nettoie `organizations.slack_team_id` + supprime le token du Vault

4. **Impact playbooks** : quand Slack est connecte, l'action `slack_notify` des playbooks utilise le Bot Token de l'organisation (via `chat.postMessage`) au lieu du webhook global. Le canal Slack configure dans l'action du playbook (`config.channel`) est utilise comme destination.

---

## Tache 1 — Carte Slack sur la page Parametres

### Objectif
Ajouter une 3eme carte d'integration Slack a cote de Stripe et HubSpot sur la page `/dashboard/settings`.

### Fichier a modifier
`src/app/dashboard/settings/page.tsx`

### Changements

**1. Recuperer l'integration Slack dans la query existante :**
```typescript
// La query organization_integrations recupere deja tous les providers
// Ajouter la resolution Slack
const slackInt = integrations.find((i) => i.provider === 'slack')
```

**2. Passer la grille de 2 a 3 colonnes :**
```tsx
<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
```

**3. Ajouter la carte Slack :**
```tsx
<IntegrationCard
  name="Slack"
  description="Notifications playbook dans vos canaux Slack"
  connected={slackInt?.status === 'active'}
  method={slackInt?.integration_method}
  accountId={slackInt?.provider_account_id}
  accentColor="bg-fuchsia-500"
/>
```

**4. Mettre a jour IntegrationCard** pour afficher "Bot Token" au lieu de "Cle API" quand `method === 'api_key'` et `name === 'Slack'` :
```tsx
{method && (
  <span>
    Methode : <span className="font-medium text-slate-700">
      {method === 'api_key'
        ? (name === 'Slack' ? 'Bot Token' : 'Cle API')
        : 'OAuth'}
    </span>
  </span>
)}
```

---

## Tache 2 — Composant client SlackConnect

### Objectif
Creer un composant client interactif pour connecter/deconnecter Slack via Bot Token.

### Fichier a creer
`src/components/SlackConnect.tsx`

### UI attendue

```
┌─────────────────────────────────────────────────────┐
│ Slack                                    [Connecte] │
│                                                     │
│ [Si non connecte]                                   │
│ Connectez votre workspace Slack pour que les        │
│ playbooks envoient des notifications dans vos       │
│ canaux.                                             │
│                                                     │
│ 1. Creez une Slack App sur api.slack.com/apps       │
│ 2. Ajoutez le scope "chat:write" au Bot Token       │
│ 3. Installez l'app dans votre workspace             │
│ 4. Copiez le Bot User OAuth Token (xoxb-...)        │
│                                                     │
│ [Input: xoxb-xxxx...] [Bouton "Connecter"]          │
│                                                     │
│ [Si connecte]                                       │
│ ✓ Workspace : Mon Workspace (T0123XXX)              │
│ [Bouton "Revoquer"]                                 │
└─────────────────────────────────────────────────────┘
```

### Implementation

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'

interface SlackConnectProps {
  connected: boolean
  teamId?: string | null
  teamName?: string | null
}

export default function SlackConnect({ connected, teamId, teamName }: SlackConnectProps) {
  const [token, setToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const router = useRouter()

  // Validation locale (meme regles que le backend)
  function validateToken(value: string): string | null {
    const trimmed = value.trim()
    if (!trimmed) return 'Token requis'
    if (!trimmed.startsWith('xoxb-') && !trimmed.startsWith('xoxp-')) {
      return 'Le token doit commencer par xoxb- (Bot Token)'
    }
    if (trimmed.length < 30) return 'Token trop court'
    return null
  }

  async function handleConnect() {
    const validationError = validateToken(token)
    if (validationError) {
      setError(validationError)
      return
    }

    setLoading(true)
    setError(null)
    setSuccess(null)

    try {
      const supabase = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      )
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        setError('Session expiree — reconnectez-vous')
        return
      }

      const resp = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/integration-oauth/slack/bot-token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ bot_token: token.trim() }),
        },
      )

      const data = await resp.json()

      if (!resp.ok) {
        // Messages d'erreur adaptes par status code
        if (resp.status === 401) setError('Token invalide ou revoque')
        else if (resp.status === 409) setError('Slack est deja connecte')
        else if (resp.status === 502) setError('Impossible de joindre Slack — reessayez')
        else setError(data.error ?? 'Erreur inconnue')
        return
      }

      setSuccess(`Workspace "${data.team_name}" connecte`)
      setToken('')
      router.refresh() // Refresh la page serveur pour mettre a jour le statut
    } catch {
      setError('Erreur reseau — verifiez votre connexion')
    } finally {
      setLoading(false)
    }
  }

  async function handleRevoke() {
    if (!confirm('Revoquer la connexion Slack ? Les playbooks utiliseront le webhook global.')) return

    setLoading(true)
    setError(null)

    try {
      const supabase = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      )
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      const resp = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/integration-oauth/revoke`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ provider: 'slack' }),
        },
      )

      if (resp.ok) {
        setSuccess('Slack deconnecte')
        router.refresh()
      } else {
        const data = await resp.json()
        setError(data.error ?? 'Erreur lors de la revocation')
      }
    } catch {
      setError('Erreur reseau')
    } finally {
      setLoading(false)
    }
  }

  // ... render avec les etats connected/loading/error/success
}
```

### Integration dans la page Parametres

Deux options :
- **Option A (simple)** : Ajouter `SlackConnect` sous la grille des `IntegrationCard` dans une section dediee
- **Option B (remplacer)** : Transformer les cartes statiques en composants clients interactifs pour les 3 providers

Option A recommandee pour le V1 :
```tsx
{/* Sous la grille IntegrationCard */}
<SlackConnect
  connected={slackInt?.status === 'active'}
  teamId={slackInt?.provider_account_id}
/>
```

---

## Tache 3 — Indicateur Slack dans la configuration des playbooks

### Objectif
Quand Slack est connecte, afficher un indicateur dans l'editeur de playbook pour confirmer que les actions `slack_notify` utiliseront le Bot Token de l'organisation.

### Fichier a modifier
Page ou composant d'edition de playbook (detail/edition d'action)

### Changements

**Dans la configuration d'une action `slack_notify`** :

```tsx
{/* Si Slack connecte */}
<div className="flex items-center gap-2 text-xs text-emerald-600 bg-emerald-50 rounded-lg px-3 py-2">
  <CheckCircle className="w-4 h-4" />
  <span>Slack connecte — les messages seront envoyes via votre Bot Token</span>
</div>

{/* Si Slack non connecte */}
<div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
  <AlertTriangle className="w-4 h-4" />
  <span>Slack non connecte — les messages utiliseront le webhook global</span>
</div>
```

**Verifier le statut Slack** : query `organization_integrations` pour le provider `slack` avec `status === 'active'`, ou appeler `GET /integration-oauth/status` si l'information n'est pas deja disponible.

---

## Tache 4 — Guide "Comment creer un Bot Token Slack"

### Objectif
Ajouter un lien ou un panneau d'aide expliquant comment obtenir un Bot Token Slack.

### Contenu du guide (inline ou modal)

```
Comment obtenir un Bot Token Slack :

1. Allez sur https://api.slack.com/apps
2. Cliquez "Create New App" > "From scratch"
3. Donnez un nom (ex: "Sentio AI") et selectionnez votre workspace
4. Dans le menu gauche, allez dans "OAuth & Permissions"
5. Dans "Bot Token Scopes", ajoutez :
   - chat:write (envoyer des messages)
   - channels:read (lister les canaux publics)
6. Cliquez "Install to Workspace" en haut de la page
7. Autorisez l'application
8. Copiez le "Bot User OAuth Token" (commence par xoxb-)
9. Collez-le dans le champ ci-dessus

Note : le bot doit etre invite dans les canaux ou il doit poster.
Pour inviter le bot : tapez /invite @Sentio AI dans le canal Slack.
```

### Implementation
- Composant collapsible `<details>` ou lien vers une modal
- Affiche uniquement quand Slack n'est pas connecte
- Style : `text-xs text-slate-500` avec `bg-slate-50 rounded-lg p-4`

---

## Schema de donnees

### organization_integrations (pour Slack)
```json
{
  "provider": "slack",
  "vault_access_token_id": "uuid",       // Bot Token chiffre dans Vault
  "provider_account_id": "T0123XXX",      // Slack Team ID
  "scopes": ["chat:write", "channels:read"],
  "status": "active",
  "integration_method": "api_key"         // api_key pour les Bot Tokens
}
```

### organizations
```sql
slack_team_id TEXT NULL  -- Slack Team ID (identifiant workspace)
```

---

## Endpoints de reference

| Endpoint | Methode | Usage |
|----------|---------|-------|
| `/functions/v1/integration-oauth/slack/bot-token` | POST | Connecter Slack |
| `/functions/v1/integration-oauth/status` | GET | Statut integrations |
| `/functions/v1/integration-oauth/revoke` | POST | Revoquer (body: `{provider:"slack"}`) |

---

## Priorite d'implementation

1. **Tache 1** — Carte Slack sur Parametres (5 min, modification mineure)
2. **Tache 2** — Composant SlackConnect (30 min, composant client)
3. **Tache 4** — Guide Bot Token (10 min, contenu statique)
4. **Tache 3** — Indicateur dans l'editeur de playbook (15 min, conditionnel)

## Contraintes
- Zero-PII : ne jamais afficher d'email ou nom — uniquement Team ID
- Multi-tenant : toutes les queries scopees par org_id via RLS/JWT
- Texte en francais
- Tailwind CSS uniquement, pas de CSS custom
- Pattern existant : reproduire le meme flow que Stripe/HubSpot API Key
- Le token est un secret : input `type="password"`, jamais affiche apres connexion
