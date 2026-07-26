# Contract: Export CSV de playbook

## `GET /playbook-export?playbook_id={uuid}`

**Auth**: Bearer JWT (ES256), `verify_jwt = false` + vérification dans le code (pattern existant `_shared/auth.ts`).

**Tenant**: `organization_id` résolu depuis le JWT, playbook et comptes scopés strictement à cette organisation.

**Réponse succès (200)** : `Content-Type: text/csv`, corps CSV RFC 4180 UTF-8.

Colonnes (ordre fixe) :
```
account_ref,mrr_at_risk_cents,message
```

**Cas d'erreur** :
- `404` — playbook inexistant ou n'appartenant pas à l'organisation de l'appelant.
- `200` avec CSV en-tête seul — playbook valide mais aucun compte éligible actuellement (pas une erreur).
- Le corps du `message` indique explicitement l'absence de template (ex: `"Aucun template actif pour ce type de playbook — contactez votre administrateur"`) si aucun `playbook_message_templates` actif n'existe pour la catégorie du playbook, plutôt que d'échouer la requête entière.

**Garantie Zero-PII** : aucune colonne, ni aucune valeur intermédiaire journalisée (logs, DLQ, Slack alert) ne doit contenir email, nom de personne, téléphone ou IP. Vérifiable par test automatisé (cf. spec SC-003).

---

## `playbook-crud` — extension pour `playbook_message_templates`

Réutilisation du pattern REST existant de `playbook-crud` (ou nouvelle fonction dédiée `playbook-templates-crud` — décision d'implémentation à trancher en `/speckit-tasks`, cette spec ne préjuge pas du découpage en Edge Functions).

| Méthode | Route | Rôle |
|---|---|---|
| `GET` | `/playbook-templates` | Liste des templates de l'organisation, filtrable par `template_category` |
| `POST` | `/playbook-templates` | Création d'un template |
| `PATCH` | `/playbook-templates/{id}` | Modification (`body`, `is_active`, `is_default`, `name`) |

Toutes les routes : Auth JWT ES256 + scoping `organization_id` obligatoire, conformément au pattern Edge Function obligatoire de CLAUDE.md.
