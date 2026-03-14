# Prompt Frontend — Playbook Execution UX v2

## Contexte

Le backend d'execution des playbooks fonctionne correctement. **200 executions `completed`** existent en base pour le playbook "Onboarding nouveaux comptes". Cependant, le frontend affiche "0 executions creees" car :

1. **Le frontend ne montre pas le `message` du backend** — quand tous les comptes ont deja ete traites (cooldown 24h), le backend retourne `{ success: true, executions_created: 0, message: "All eligible accounts have recent executions" }` mais le frontend affiche juste "0 executions creees" sans explication.
2. **Les stats d'execution ne se rafraichissent pas** — apres une execution reussie, la page detail affiche toujours "0 EXECUTIONS / 0 TERMINEES" car elle ne recharge pas les donnees.
3. **Le bouton "Executer" ne passe pas `target_mode: 'eligible'`** — le backend a un fallback automatique, mais le frontend devrait etre explicite.

---

## Bug #1 — Modale d'execution : afficher le `message` du backend

### Probleme actuel

La modale affiche toujours "Execution lancee avec succes — N executions creees" sans distinction entre :
- 200 comptes traites (succes)
- 0 comptes car cooldown actif
- 0 comptes car aucun eligible

### Fix requis

```typescript
const data = await res.json()

if (!res.ok) {
  // Erreur serveur (400, 403, 404, 500)
  toast.error(data.error || 'Erreur lors de l\'execution')
  return
}

if (data.status === 'pending_approval') {
  // Playbook semi_automated → attente validation
  toast.info(`Execution en attente d'approbation — ${data.accounts_count} comptes`)
} else if (data.executions_created > 0) {
  // Succes — comptes traites
  const msg = data.has_more
    ? `${data.executions_created} comptes traites (${data.total_eligible} eligibles au total — max 200 par run)`
    : `${data.executions_created} comptes traites`
  toast.success(msg)
  // IMPORTANT : recharger les donnees de la page
  router.refresh() // ou refetch du playbook detail
} else {
  // 0 comptes — AFFICHER LE MESSAGE DU BACKEND
  const messageMap: Record<string, string> = {
    'All eligible accounts have recent executions':
      'Tous les comptes eligibles ont deja ete traites dans les dernieres 24h. Reessayez plus tard.',
    'No accounts match eligibility criteria':
      'Aucun compte ne correspond aux criteres d\'eligibilite du playbook.',
    'No accounts found':
      'Aucun compte trouve dans l\'organisation.',
    'No eligible accounts':
      'Aucun compte eligible dans le segment cible.',
  }
  const displayMsg = messageMap[data.message] || data.message || 'Aucun compte eligible'
  toast.warning(displayMsg)
}
```

### Champs de reponse complets

```typescript
interface ExecuteResponse {
  // Cas automated/manual
  success?: boolean
  playbook_id?: string
  executions_created?: number    // Nombre d'executions creees dans ce run
  total_eligible?: number        // Total comptes eligibles (avant cap 200)
  has_more?: boolean             // true si plus de 200 eligibles
  message?: string               // Message explicatif (cooldown, no match, etc.)
  results?: Array<{
    execution_id: string
    account_id: string
    status: 'completed' | 'failed' | 'partially_completed' | 'running'
    steps: number
    completed: number
    failed: number
  }>

  // Cas semi_automated
  execution_id?: string
  status?: 'pending_approval'
  accounts_count?: number
}
```

---

## Bug #2 — Stats d'execution non rafraichies

### Probleme actuel

La page detail playbook charge les stats au mount initial mais ne les recharge pas apres une execution. Le bloc "Statistiques d'execution" reste a 0 meme apres 200 executions reussies.

### Fix requis

Apres chaque appel `playbook-execute` reussi (`executions_created > 0`), la page doit :
1. Recharger le detail du playbook via `GET /functions/v1/playbook-crud?id=<playbook_id>`
2. Les stats mises a jour seront dans `execution_stats` :

```typescript
// Exemple de reponse apres 200 executions
{
  "execution_stats": {
    "total_executions": 200,
    "completed": 200,
    "failed": 0,
    "in_progress": 0,
    "targeted_count": 200,
    "reached_count": 200,
    "converted_count": 0,
    "mrr_recovered_cents": 0,
    "mrr_expansion_cents": 0,
    "last_executed_at": "2026-03-14T05:49:50.000Z"
  }
}
```

### Implementation recommandee

```typescript
// Dans le composant page detail playbook
const [playbook, setPlaybook] = useState<PlaybookDetail | null>(null)

async function reloadPlaybook() {
  const res = await fetch(
    `${supabaseUrl}/functions/v1/playbook-crud?id=${playbookId}`,
    { headers: { 'Authorization': `Bearer ${session.access_token}` } }
  )
  if (res.ok) {
    const data = await res.json()
    setPlaybook(data)
  }
}

// Appeler reloadPlaybook() apres chaque execution reussie
async function handleExecute() {
  const res = await fetch(/* ... playbook-execute ... */)
  const data = await res.json()
  // ... afficher toast ...
  if (data.executions_created > 0) {
    await reloadPlaybook()  // ← CRUCIAL
  }
}
```

---

## Bug #3 — Appel API explicite avec `target_mode`

### Probleme actuel

Le frontend envoie probablement `{ playbook_id }` sans specifier de mode de ciblage. Le backend a un fallback automatique vers `eligible`, mais il est plus robuste d'etre explicite.

### Fix requis

Le bouton "Executer" (mode par defaut) doit envoyer :

```typescript
const res = await fetch(`${supabaseUrl}/functions/v1/playbook-execute`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    playbook_id: playbook.id,
    target_mode: 'eligible',  // ← AJOUTER EXPLICITEMENT
  }),
})
```

**Ne PAS envoyer `organization_id`** — le backend l'injecte depuis le JWT.

---

## Bug #4 — Cooldown UX

### Probleme

Quand un utilisateur clique "Executer" et que tous les comptes sont en cooldown, il voit "0 comptes traites" sans comprendre pourquoi.

### UX recommandee

1. **Avant l'execution** : afficher la date de derniere execution dans la modale
   ```
   Derniere execution : il y a 2h (200 comptes traites)
   Cooldown actif : les comptes deja traites ne seront pas re-executes avant 24h.
   ```

2. **Option "Forcer la re-execution"** : checkbox dans la modale (envoie `cooldown_hours: 0`)
   ```
   □ Forcer la re-execution (ignorer le cooldown de 24h)
   ```
   Avec confirmation : "Les comptes deja traites seront re-executes. Continuer ?"

3. **Apres cooldown hit** : message explicatif clair
   ```
   ℹ Tous les 1348 comptes eligibles ont deja ete traites dans les dernieres 24h.
   Le prochain run sera possible le 15 mars a 05:49.
   ```

### Donnees disponibles pour le cooldown UX

Le playbook detail retourne `last_executed_at` dans les stats. Utiliser ce champ pour calculer quand le cooldown expire :

```typescript
const lastExec = playbook.execution_stats?.last_executed_at
if (lastExec) {
  const cooldownEnd = new Date(new Date(lastExec).getTime() + 24 * 3600000)
  const now = new Date()
  if (now < cooldownEnd) {
    // Afficher warning dans la modale
    const hoursLeft = Math.ceil((cooldownEnd.getTime() - now.getTime()) / 3600000)
    setWarning(`Cooldown actif — prochain run possible dans ${hoursLeft}h`)
  }
}
```

---

## Contrat API complet — Rappel

### POST /functions/v1/playbook-execute

```typescript
// Request body
{
  playbook_id: string              // REQUIS
  target_mode?: 'eligible'         // RECOMMANDE — backend filtre par eligibility_criteria
  account_ids?: string[]           // OU — liste explicite de comptes
  segment_id?: string              // OU — segment cible
  execution_source?: string        // Defaut: 'manual'
  cooldown_hours?: number          // Defaut: 24 — mettre 0 pour forcer
}

// NE PAS ENVOYER organization_id — injecte depuis le JWT
```

### GET /functions/v1/playbook-crud?id=<playbook_id>

Retourne la structure complete du playbook avec stats, comptes eligibles, conditions et actions.

Voir le prompt `PROMPT_FRONTEND_PLAYBOOK_EXECUTE_FIX.md` pour le detail complet du type `PlaybookDetail`.

### POST /functions/v1/playbook-crud/<id>/approve-execution

```typescript
{ execution_id: string }
// Retourne: { success: true, execution_id, status: 'completed' | 'failed', accounts_count }
```

### POST /functions/v1/playbook-crud/<id>/reject-execution

```typescript
{ execution_id: string, reason?: string }
// Retourne: { success: true, execution_id, status: 'cancelled' }
```

---

## Resume des actions statut par type

| Action | Statut | Comportement |
|--------|--------|-------------|
| `slack_notify` | **Actif** | Envoie un message Slack (webhook global ou bot token per-org) |
| `create_task` | **Actif** | Cree une tache HubSpot CRM + association company (skip si HubSpot non connecte) |
| `send_email_hubspot` | **Actif** | Cree un email DRAFT dans HubSpot (skip si non connecte) |
| `flag_for_review` | **Actif** | Ajoute un flag JSONB sur le compte |
| `log_note` | **Actif** | Insere une note dans `account_notes` |
| `assign_owner` | Log-only | Logue l'action, pas encore implemente |
| `update_tag` | Log-only | Logue l'action, pas encore implemente |
| `schedule_review` | Log-only | Logue l'action, pas encore implemente |

---

## Fichiers a modifier

| Fichier | Action |
|---------|--------|
| Modale d'execution | **MODIFIER** — Afficher `data.message` du backend, gerer les cas cooldown/no match |
| Page detail playbook | **MODIFIER** — Recharger les stats apres execution (`reloadPlaybook()`) |
| Appel playbook-execute | **MODIFIER** — Ajouter `target_mode: 'eligible'` explicitement |
| Modale d'execution (optionnel) | **AJOUTER** — Warning cooldown + option forcer (`cooldown_hours: 0`) |

## Contraintes

- **Zero-PII** : jamais d'email, nom, telephone dans l'UI. Uniquement `stripe_customer_id` et `hubspot_company_id`.
- **Pas de `organization_id`** dans les appels frontend — le backend l'injecte depuis le JWT.
- **Cooldown 24h** par defaut : un compte ne peut pas etre traite 2 fois par le meme playbook en 24h.
- **MAX 200 comptes** par execution. Si `has_more: true`, afficher combien de comptes restent (`total_eligible - executions_created`).
