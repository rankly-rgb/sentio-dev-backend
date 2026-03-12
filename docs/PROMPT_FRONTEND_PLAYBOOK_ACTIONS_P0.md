# Prompt Frontend — Actions Playbook P0 (slack_notify, flag_for_review, log_note)

## Contexte

Le backend Sentio AI supporte maintenant 4 actions playbook fonctionnelles (pas log-only) :
- `create_task` → crée une tâche HubSpot CRM (Sprint 2)
- `slack_notify` → envoie un message Slack (P0)
- `flag_for_review` → pose un flag JSONB sur le compte (P0)
- `log_note` → insère une note dans `account_notes` (P0)

Les 3 actions restantes (`assign_owner`, `update_tag`, `schedule_review`) sont encore log-only (P1/P2).

Ce prompt décrit les changements frontend nécessaires pour exploiter ces actions.

---

## Tâche 1 — Affichage des flags sur la page compte

### Contexte backend
- `accounts.flags` est un array JSONB : `[{ flag: string, set_at: string, playbook_id: string | null, reason: string }]`
- Exemples de flags : `review_needed`, `escalation`, `vip`, `at_risk`
- Les flags sont posés par les playbooks via l'action `flag_for_review`

### Changements frontend

**Page détail compte (`/dashboard/accounts/[id]`)** :
- Afficher les flags actifs sous forme de badges colorés dans le header du compte
- Badge `review_needed` → jaune/warning
- Badge `escalation` → rouge/danger
- Badge `vip` → violet/info
- Autres flags → gris/neutral
- Tooltip au hover : raison + date + "Posé par [playbook title]"
- Bouton "Retirer" (icône ×) pour supprimer un flag manuellement

**Page liste comptes (`/dashboard/accounts`)** :
- Colonne optionnelle "Flags" dans le tableau (icônes badges, pas de texte)
- Filtre rapide "Avec flags" pour ne voir que les comptes flaggés

**API** : pas de nouvel endpoint nécessaire. Les flags sont déjà dans la réponse `accounts` (colonne `flags` JSONB).

**Retrait de flag** : PATCH direct sur l'account via Supabase client :
```typescript
// Retirer un flag par nom
const { data: account } = await supabase
  .from('accounts')
  .select('flags')
  .eq('id', accountId)
  .single()

const updatedFlags = (account.flags || []).filter(f => f.flag !== flagName)

await supabase
  .from('accounts')
  .update({ flags: updatedFlags })
  .eq('id', accountId)
```

---

## Tâche 2 — Affichage des notes sur la page compte

### Contexte backend
- Table `account_notes` avec RLS (org_isolation)
- Colonnes : `id`, `account_id`, `organization_id`, `note_type`, `title`, `body`, `source`, `playbook_id`, `execution_id`, `created_at`
- `note_type` : `playbook_action` (automatique), `manual` (future), `system`
- `source` : `playbook` (automatique)

### Changements frontend

**Page détail compte (`/dashboard/accounts/[id]`)** :
- Section "Notes" en bas de page (ou onglet si la page a des tabs)
- Liste chronologique inversée (plus récent en haut)
- Chaque note affiche :
  - Icône selon `note_type` : 📋 playbook_action, ✏️ manual, ⚙️ system
  - Titre en gras
  - Body en texte normal
  - Date relative ("il y a 2h") avec date absolue au hover
  - Badge "Playbook" si source === 'playbook', avec le nom du playbook si disponible
- Pagination : 10 notes par page, bouton "Voir plus"

**Query** :
```typescript
const { data: notes } = await supabase
  .from('account_notes')
  .select('id, title, body, note_type, source, playbook_id, created_at')
  .eq('account_id', accountId)
  .order('created_at', { ascending: false })
  .range(0, 9)
```

**Optionnel — Ajout de note manuelle** (future, pas P0) :
- Textarea + bouton "Ajouter une note"
- `note_type: 'manual'`, `source: 'manual'`

---

## Tâche 3 — Indicateur d'action dans la séquence playbook

### Contexte backend
Sur la page détail d'un playbook, les actions sont affichées en séquence. Il faut indiquer visuellement lesquelles sont fonctionnelles vs log-only.

### Changements frontend

**Page détail playbook (`/dashboard/playbooks/[id]`)** :
- Dans la liste des actions de la séquence, ajouter un indicateur de statut :
  - `create_task` → badge vert "Actif" + icône HubSpot
  - `slack_notify` → badge vert "Actif" + icône Slack (MessageSquare)
  - `flag_for_review` → badge vert "Actif" + icône Flag
  - `log_note` → badge vert "Actif" + icône FileText
  - `assign_owner` → badge gris "Bientôt" + icône UserCheck
  - `update_tag` → badge gris "Bientôt" + icône Tag
  - `schedule_review` → badge gris "Bientôt" + icône CalendarClock

**Mapping des types d'action vers labels français :**
```typescript
const ACTION_LABELS: Record<string, string> = {
  slack_notify: 'Notification Slack',
  create_task: 'Tâche HubSpot',
  flag_for_review: 'Signaler pour revue',
  log_note: 'Ajouter une note',
  assign_owner: 'Assigner un responsable',
  update_tag: 'Mettre à jour un tag',
  schedule_review: 'Planifier une revue',
}

const ACTIVE_ACTIONS = ['slack_notify', 'create_task', 'flag_for_review', 'log_note']
```

---

## Tâche 4 — Résultat d'exécution enrichi

### Contexte backend
L'endpoint `playbook-execute` retourne maintenant des résultats détaillés par action :
```json
{
  "success": true,
  "playbook_id": "pb-uuid",
  "executions_created": 5,
  "results": [
    {
      "execution_id": "exec-uuid",
      "account_id": "acc-uuid",
      "status": "completed",
      "steps": 3,
      "completed": 3,
      "failed": 0
    }
  ]
}
```

Et chaque exécution a un `actions_completed` JSONB dans `playbook_executions` :
```json
[
  { "action_type": "slack_notify", "order": 1, "status": "completed", "message": "..." },
  { "action_type": "flag_for_review", "order": 2, "status": "completed", "message": "..." },
  { "action_type": "create_task", "order": 3, "status": "skipped", "message": "HubSpot not connected" }
]
```

### Changements frontend

**Après exécution d'un playbook** :
- Toast/notification avec résumé : "5 comptes traités, 3 réussis, 1 échoué, 1 ignoré"
- Si des actions ont été `skipped` (ex: HubSpot non connecté), afficher un avertissement : "Certaines actions ont été ignorées. Vérifiez la configuration des intégrations."

**Page détail exécution (si elle existe)** :
- Timeline des actions par compte avec icônes de statut :
  - ✅ completed (vert)
  - ❌ failed (rouge)
  - ⏭️ skipped (gris)
- Message détaillé pour chaque action

**Query exécutions** :
```typescript
const { data: executions } = await supabase
  .from('playbook_executions')
  .select('id, account_id, execution_status, actions_completed, completed_steps, failed_steps, started_at, completed_at')
  .eq('playbook_id', playbookId)
  .order('started_at', { ascending: false })
  .limit(20)
```

---

## Tâche 5 — Configuration des actions dans l'éditeur de playbook

### Contexte backend
Chaque action a un `config` JSONB libre. Voici les champs supportés par type :

| Action | Config fields |
|--------|--------------|
| `slack_notify` | `channel?: string` (ex: "cs-team"), `message?: string` (template avec variables) |
| `flag_for_review` | `flag?: string` (default: "review_needed"), `reason?: string` |
| `log_note` | `title?: string`, `body?: string` |
| `create_task` | `title?: string`, `due_days?: number` (default: 3) |

### Variables de template Slack
Le champ `message` de `slack_notify` supporte ces variables :
- `{stripe_customer_id}` → ID Stripe du compte
- `{mrr_eur}` → MRR en euros
- `{churn_risk}` → score de risque churn (0-100)
- `{health_score}` → score de santé (0-100)
- `{playbook}` → titre du playbook

Exemple : `"⚠️ Compte {stripe_customer_id} à risque (churn={churn_risk}%) — MRR: {mrr_eur}€"`

### Changements frontend

**Éditeur de playbook — panneau de configuration d'action :**
- Quand l'utilisateur ajoute/édite une action, afficher un formulaire contextuel selon le type :

**slack_notify** :
- Input "Canal Slack" (optionnel, placeholder: "cs-team")
- Textarea "Message personnalisé" (optionnel)
- Sous le textarea : liste des variables disponibles cliquables ({stripe_customer_id}, etc.)
- Preview du message avec données fictives

**flag_for_review** :
- Input "Nom du flag" (default: "review_needed")
- Input "Raison" (default: "Signalé par playbook")

**log_note** :
- Input "Titre de la note" (optionnel)
- Textarea "Contenu" (optionnel)
- Note : si vides, le backend génère des valeurs par défaut avec les scores du compte

**create_task** :
- Input "Titre de la tâche" (default: "Tâche Sentio")
- Input numérique "Échéance (jours)" (default: 3)
- Note : nécessite HubSpot connecté

---

## Schéma DB de référence

### accounts.flags (JSONB array)
```sql
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS flags JSONB NOT NULL DEFAULT '[]'::jsonb;
```

### account_notes
```sql
CREATE TABLE account_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  note_type TEXT NOT NULL DEFAULT 'playbook_action' CHECK (note_type IN ('playbook_action', 'manual', 'system')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'playbook',
  playbook_id UUID NULL,
  execution_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE account_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON account_notes
  FOR ALL
  USING (organization_id = (SELECT user_organization_id()))
  WITH CHECK (organization_id = (SELECT user_organization_id()));
```

---

## Priorité d'implémentation

1. **Tâche 3** — Indicateur actif/bientôt dans la séquence d'actions (rapide, UX immédiate)
2. **Tâche 1** — Flags sur les comptes (visible, actionnable)
3. **Tâche 2** — Notes sur les comptes (historique des actions)
4. **Tâche 4** — Résultat d'exécution enrichi (feedback utilisateur)
5. **Tâche 5** — Configuration des actions dans l'éditeur (power user)

## Contraintes
- Zero-PII : ne jamais afficher d'email/nom/téléphone
- Multi-tenant : toutes les queries sont scopées par org_id via RLS
- Pas de nouvel endpoint backend nécessaire — tout est accessible via Supabase client direct
