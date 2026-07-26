# Contract: Boucle de preuve de résultat des playbooks

## `POST /playbook-execute/{execution_id}/mark-executed`

*(ou endpoint dédié — le découpage exact entre extension de `playbook-execute` existant et nouvelle fonction sera tranché en `/speckit-tasks`)*

**Auth**: Bearer JWT (ES256), scoping `organization_id` obligatoire.

**Effet** :
- Si l'exécution n'est pas déjà marquée exécutée : renseigne `executed_at = now()` (si pas déjà défini) et calcule `attribution_deadline_at = executed_at + attribution_window_days` (défaut 14 jours si le playbook n'a pas de valeur configurée).
- Si déjà marquée exécutée : réponse idempotente (200, pas de nouvel horodatage — cf. Assumptions du spec).

**Réponse succès (200)** : `{ execution_id, executed_at, attribution_deadline_at }`

**Erreurs** :
- `404` — exécution inexistante ou hors organisation de l'appelant.

---

## `POST /playbook-outcome-detector` (interne, appelée en fire-and-forget par `stripe-webhook`)

**Auth**: `service_role` uniquement (appel interne, même pattern que `playbook-executor` existant) — jamais exposée publiquement, `verify_jwt` selon convention interne des fonctions déjà appelées ainsi (`playbook-executor`).

**Body** : `{ organization_id, stripe_customer_id }`

**Effet** : marque comme résolues (`account_converted = true`, `resolved_via = 'invoice_paid_auto'`) toutes les `playbook_executions` du compte en attente d'attribution active (cf. data-model.md).

**Garantie** : n'échoue jamais de façon bloquante pour l'appelant (`stripe-webhook`) — appelée en fire-and-forget, erreurs journalisées uniquement (`console.warn`), pas de retry, pas de DLQ (cohérent avec le traitement existant de `invoice.payment_failed`).

**Non-régression (FR-005)** : cet appel est strictement additif après le traitement existant de `handleInvoiceEvent` pour `invoice.paid` — aucune modification de `handleInvoiceEvent` lui-même.

---

## `GET /playbook-link/{execution_id}`

**Auth**: aucune (lien public destiné à être cliqué par un destinataire externe, sans session) — mais l'existence de `execution_id` est vérifiée avant tout traitement (404 si inconnu, sans fuite d'information sur l'organisation).

**Effet** :
- Insère une ligne dans `playbook_execution_clicks` (`organization_id`, `playbook_execution_id`, `stripe_customer_id` dérivé de l'exécution, `clicked_at = now()`).
- Répond par une redirection HTTP `302` vers la destination associée à l'exécution (destination exacte à définir en tasks — probablement une URL de destination générique produit, pas une donnée arbitraire fournie par l'appelant, pour éviter tout risque d'open redirect).

**Garantie Zero-PII (FR-008)** : aucune donnée personnelle dans la requête n'est journalisée ni stockée — l'endpoint ne lit ni ne transmet aucun paramètre autre que `execution_id`.

**Sécurité** : la destination de redirection DOIT être résolue côté serveur à partir de l'exécution (pas depuis un paramètre de requête arbitraire), pour éviter une vulnérabilité open-redirect — cohérent avec le correctif open-redirect déjà appliqué ailleurs dans le produit (cf. `docs/CHANGELOG_STABILITY.md`, Stability Audit v2/v3).
