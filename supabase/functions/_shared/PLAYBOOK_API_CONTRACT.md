# Playbook API Contract

Source de vérité pour l'intégration frontend ↔ backend Sentio AI.

**Zero-PII** : aucun endpoint ne retourne ni n'accepte d'email, nom, téléphone ou IP.
Seuls des identifiants opaques (`stripe_customer_id`) et des métriques agrégées circulent.

---

## Schémas de tables

### `playbook_destinations`

```typescript
interface PlaybookDestination {
  id: string                          // UUID
  organization_id: string             // UUID
  name: string                        // Ex: "Brevo - Séquence churn critique"
  connector: ConnectorType            // Voir enum ci-dessous
  is_active: boolean
  trigger_segments: string[]          // Ex: ["en_danger_critique", "en_churn"]
  trigger_churn_threshold: number | null  // 0-100. null = pas de seuil
  trigger_on_invoice_past_due: boolean
  api_key_vault_key: string | null    // Clé API du connecteur (V1 : valeur directe)
  api_endpoint: string | null         // URL override ou Slack webhook URL
  template_id: string | null          // ID liste/séquence/campagne côté outil tiers
  message_template: string | null     // Template avec variables {{...}}
  last_triggered_at: string | null    // ISO 8601
  created_at: string                  // ISO 8601
  updated_at: string                  // ISO 8601
}
```

**Contrainte** : au moins un déclencheur doit être configuré parmi :
- `trigger_segments.length > 0`
- `trigger_churn_threshold !== null`
- `trigger_on_invoice_past_due === true`

### `playbook_execution_logs`

```typescript
interface PlaybookExecutionLog {
  id: string                          // UUID
  organization_id: string             // UUID
  destination_id: string              // UUID → playbook_destinations.id
  account_id: string                  // UUID → accounts.id
  stripe_customer_id: string          // Identifiant opaque Stripe (ex: cus_xxx)
  connector: ConnectorType
  trigger_reason: TriggerReason
  segment_at_trigger: string | null
  churn_risk_at_trigger: number | null
  mrr_cents_at_trigger: number | null
  success: boolean
  http_status: number | null
  error_message: string | null        // Tronqué à 500 chars, sans PII
  connector_response: string | null   // Tronqué à 500 chars, sans PII
  executed_at: string                 // ISO 8601
  created_at: string                  // ISO 8601
  updated_at: string                  // ISO 8601
}
```

---

## Enums

### `ConnectorType`
```typescript
type ConnectorType =
  | 'brevo'
  | 'lemlist'
  | 'activecampaign'
  | 'mailchimp'
  | 'hubspot'
  | 'slack'
  | 'custom'
```

### `TriggerReason`
```typescript
type TriggerReason =
  | 'segment_change'
  | 'churn_threshold'
  | 'invoice_past_due'
  | 'manual'
```

### `trigger_segments` — valeurs valides
```typescript
type SegmentValue =
  | 'champions'
  | 'en_expansion'
  | 'stables'
  | 'a_risque_leger'
  | 'en_danger_critique'
  | 'impayes'
  | 'en_churn'
  | 'nouveaux'
```

---

## Variables `message_template`

Le template supporte ces variables (remplacées à l'exécution) :

| Variable | Description |
|---|---|
| `{{stripe_customer_id}}` | Identifiant opaque Stripe (ex: cus_xxx) |
| `{{segment}}` | Segment actuel (ex: en_danger_critique) |
| `{{churn_risk}}` | Score de risque churn (0-100) |
| `{{mrr_eur}}` | MRR en euros (ex: 499) |
| `{{health_score}}` | Score de santé (0-100) |

**Aucune variable email, nom ou PII n'est disponible.** C'est intentionnel.

---

## Endpoints

### GET `/functions/v1/playbook-executor` — Non disponible
> Utiliser Supabase client pour lire `playbook_destinations` directement.

---

### CRUD `playbook_destinations`

Utiliser le **Supabase client** avec RLS (org_isolation automatique) :

```typescript
// Lister les destinations
const { data } = await supabase
  .from('playbook_destinations')
  .select('*')
  .order('created_at', { ascending: false })

// Créer une destination
const { data } = await supabase
  .from('playbook_destinations')
  .insert({
    name: 'Brevo - Churn critique',
    connector: 'brevo',
    trigger_segments: ['en_danger_critique'],
    api_key_vault_key: 'xkeysib-...',
    template_id: '42',
  })
  .select()
  .single()

// Mettre à jour
const { data } = await supabase
  .from('playbook_destinations')
  .update({ is_active: false })
  .eq('id', destinationId)

// Supprimer
const { error } = await supabase
  .from('playbook_destinations')
  .delete()
  .eq('id', destinationId)
```

---

### POST `/functions/v1/playbook-executor`

Déclenche les actions pour un account. Appelée en fire-and-forget par calculate-scores et stripe-webhook. Peut aussi être appelée manuellement.

**Auth** : `Authorization: Bearer <service_role_key>` (appelée service-to-service)

**Request body** :
```typescript
{
  organization_id: string      // requis
  stripe_customer_id: string   // requis
  trigger_reason: TriggerReason // requis
  account_id?: string          // optionnel — lookup auto si absent
  segment_current?: string     // optionnel — lookup auto si absent
  segment_previous?: string    // optionnel
  health_score?: number        // optionnel — lookup auto si absent
  churn_risk_score?: number    // optionnel — lookup auto si absent
  expansion_score?: number     // optionnel — lookup auto si absent
  mrr_cents?: number           // optionnel — lookup auto si absent
}
```

**Response 200** :
```typescript
{
  executed: number        // Nombre de destinations déclenchées avec succès
  failed: number          // Nombre d'échecs
  destinations: string[]  // Noms des destinations déclenchées
}
```

**Erreurs** :
- `400` : payload invalide (champs manquants ou trigger_reason inconnu)
- `404` : account introuvable pour ce stripe_customer_id
- `500` : erreur base de données critique

---

### POST `/functions/v1/playbook-test`

Teste une destination sans attendre un vrai signal.

**Auth** : `Authorization: Bearer <jwt_user>` (JWT ES256 utilisateur)

**Request body** :
```typescript
{
  destination_id: string  // UUID — requis
}
```

**Response 200** :
```typescript
{
  success: boolean
  http_status: number | null
  response: string         // Réponse tronquée à 500 chars, sans PII
}
```

**Erreurs** :
- `400` : destination_id manquant
- `401` : non authentifié
- `404` : destination inconnue ou n'appartient pas à l'org
- `500` : erreur de configuration serveur

---

### GET `/functions/v1/playbook-execution-logs`

Utiliser le **Supabase client** avec RLS :

```typescript
// Logs par destination (plus récents en premier)
const { data } = await supabase
  .from('playbook_execution_logs')
  .select('*')
  .eq('destination_id', destinationId)
  .order('executed_at', { ascending: false })
  .limit(50)

// Logs par account
const { data } = await supabase
  .from('playbook_execution_logs')
  .select('*')
  .eq('account_id', accountId)
  .order('executed_at', { ascending: false })
  .limit(20)

// Stats de succès
const { data } = await supabase
  .from('playbook_execution_logs')
  .select('success, connector, trigger_reason')
  .eq('organization_id', organizationId)
  .gte('executed_at', new Date(Date.now() - 7 * 86400000).toISOString())
```

---

## Notes d'intégration

### Afficher le statut d'une destination

```typescript
// Vérifier si une destination a été déclenchée récemment
const { data: lastLog } = await supabase
  .from('playbook_execution_logs')
  .select('success, executed_at, trigger_reason')
  .eq('destination_id', destinationId)
  .order('executed_at', { ascending: false })
  .limit(1)
  .maybeSingle()
```

### Calculer le taux de succès

```typescript
const { data: logs } = await supabase
  .from('playbook_execution_logs')
  .select('success')
  .eq('destination_id', destinationId)
  .gte('executed_at', new Date(Date.now() - 30 * 86400000).toISOString())

const successRate = logs
  ? logs.filter((l) => l.success).length / logs.length
  : null
```

### Configuration par connecteur

| Connecteur | api_key_vault_key | api_endpoint | template_id |
|---|---|---|---|
| brevo | Clé API Brevo (`xkeysib-...`) | — | ID de la liste Brevo |
| lemlist | Clé API Lemlist | — | ID de la campagne Lemlist |
| activecampaign | Clé API ActiveCampaign | URL base AC (ex: `https://xxx.api-us1.com`) | ID de l'automation |
| mailchimp | Clé API Mailchimp (`xxx-us1`) | — | ID de la liste Mailchimp (audience) |
| hubspot | Private App Token HubSpot | — | ID de la séquence HubSpot |
| slack | — | URL du webhook Slack Incoming | — |
| custom | Clé API optionnelle | URL du webhook custom | — |

---

**Aucun email ni PII n'est retourné par ces endpoints ni stocké dans ces tables.**
