# Prompt Frontend — Fix Modale Execution Playbook (V3 DEFINITIF)

## Probleme

La modale "Executer le playbook" affiche toujours "Aucun compte traite / Aucun compte eligible" parce qu'elle n'envoie pas le bon parametre au backend. Le backend fonctionne (prouve via console navigateur avec 200 comptes traites + taches creees dans HubSpot).

## Cause racine

La modale n'a que 2 modes : "Par segment" et "Par ID de comptes". Il manque le mode **"Tous les comptes eligibles"** qui doit etre le **mode par defaut**. Ce mode envoie `target_mode: 'eligible'` au backend, qui filtre lui-meme les comptes via les `eligibility_criteria` du playbook.

## Fix requis (1 seul changement)

Dans le composant de la modale d'execution, ajouter un 3e mode et en faire le defaut :

### AVANT (casse)

```typescript
// La modale force un choix segment ou account_ids
const [mode, setMode] = useState<'segment' | 'accounts'>('segment')

// L'appel API
const body: Record<string, unknown> = { playbook_id: playbook.id }
if (mode === 'segment') {
  body.segment_id = selectedSegment
} else {
  body.account_ids = selectedAccountIds
}
```

### APRES (corrige)

```typescript
// Ajouter le mode 'eligible' comme defaut
const [mode, setMode] = useState<'eligible' | 'segment' | 'accounts'>('eligible')

// L'appel API
const body: Record<string, unknown> = { playbook_id: playbook.id }
if (mode === 'eligible') {
  body.target_mode = 'eligible'     // ← LE FIX PRINCIPAL
} else if (mode === 'segment') {
  body.segment_id = selectedSegment
} else {
  body.account_ids = selectedAccountIds
}

// Cooldown optionnel (defaut 24h cote backend)
if (cooldownHours !== undefined) {
  body.cooldown_hours = cooldownHours
}
```

### UI de la modale

```
┌─────────────────────────────────────────────────────┐
│  Executer le playbook                               │
│  Choisissez comment cibler les comptes.             │
│                                                     │
│  ● Tous les comptes eligibles (N comptes)    ← DEFAUT
│  ○ Par segment                                      │
│  ○ Par ID de comptes                                │
│                                                     │
│  Cooldown: [24] heures                              │
│  □ Forcer la re-execution (cooldown = 0)            │
│                                                     │
│  [Annuler]                    [Lancer l'execution]  │
└─────────────────────────────────────────────────────┘
```

Le nombre N vient de `playbook.current_eligible_count` ou `playbook.eligible_accounts?.total` retourne par `GET /playbook-crud?id=<id>`.

## Gestion de la reponse

```typescript
const res = await fetch(`${supabaseUrl}/functions/v1/playbook-execute`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
})

const data = await res.json()

if (!res.ok) {
  toast.error(data.error || 'Erreur serveur')
  return
}

// Semi-automated → attente approbation
if (data.status === 'pending_approval') {
  toast.info(`Execution en attente d'approbation — ${data.accounts_count} comptes`)
  reloadPlaybook()
  return
}

// Succes avec comptes traites
if (data.executions_created > 0) {
  const msg = data.has_more
    ? `${data.executions_created} comptes traites sur ${data.total_eligible} eligibles`
    : `${data.executions_created} comptes traites`
  toast.success(msg)
  reloadPlaybook()  // ← RECHARGER les stats
  return
}

// 0 comptes — AFFICHER LE MESSAGE DU BACKEND (pas un message generique)
const messages: Record<string, string> = {
  'All eligible accounts have recent executions':
    'Tous les comptes eligibles ont deja ete traites dans les dernieres 24h.',
  'No accounts match eligibility criteria':
    'Aucun compte ne correspond aux criteres du playbook.',
  'No accounts found':
    'Aucun compte dans l\'organisation.',
}
toast.warning(messages[data.message] || data.message || 'Aucun compte eligible')
```

## Appel API complet

```
POST /functions/v1/playbook-execute
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "playbook_id": "uuid",          // REQUIS
  "target_mode": "eligible",      // REQUIS pour le mode par defaut
  "cooldown_hours": 24             // OPTIONNEL (defaut: 24, mettre 0 pour forcer)
}
```

**NE PAS envoyer `organization_id`** — le backend l'injecte depuis le JWT.

## Reponses du backend

```typescript
// Succes — comptes traites
{
  success: true,
  playbook_id: "uuid",
  executions_created: 200,      // Nombre de comptes traites
  total_eligible: 654,          // Total eligibles (avant cap 200)
  has_more: true,               // true si > 200 eligibles
  results: [{ execution_id, account_id, status, steps, completed, failed }]
}

// Succes — 0 comptes (TOUJOURS afficher data.message)
{
  success: true,
  executions_created: 0,
  message: "All eligible accounts have recent executions"  // ou "No accounts match..."
}

// Semi-automated — attente approbation
{
  execution_id: "uuid",
  status: "pending_approval",
  accounts_count: 200
}

// Erreur (400/403/404/500)
{
  error: "Playbook not found"
}
```

## Checklist de verification

- [ ] Le mode "Tous les comptes eligibles" est selectionne par defaut
- [ ] Le body envoye contient `target_mode: "eligible"` (verifier dans DevTools > Network > Payload)
- [ ] Le `message` du backend est affiche quand `executions_created === 0`
- [ ] Les stats se rechargent apres une execution reussie (`reloadPlaybook()`)
- [ ] Le cooldown est affiche et modifiable

## Test de validation

Apres deploiement, ouvrir la console navigateur et verifier :
1. Cliquer "Executer" sur le playbook "Recuperation comptes perdus"
2. Selectionner "Tous les comptes eligibles"
3. Dans Network, verifier que le body contient `{"playbook_id":"...","target_mode":"eligible"}`
4. La reponse doit contenir `executions_created: 200` (ou plus)
5. Les taches doivent apparaitre dans HubSpot > Taches
