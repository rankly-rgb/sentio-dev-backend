# Research: Playbooks actionnables — export CSV & bibliothèque de templates

## Contexte existant pertinent

- `_shared/playbook-engine.ts` définit déjà `VALID_PLAYBOOK_TYPES` (`manual`, `automated`, `semi_automated`, `template`) et `VALID_TEMPLATE_CATEGORIES` (`churn_prevention`, `expansion`, `renewal`, `payment_recovery`, `reactivation`). Ces catégories correspondent à la notion de "type de playbook" citée dans le besoin (payment recovery, churn risk, expansion opportunity).
- **Risque de collision de nommage** : le type `PlaybookType = 'template'` désigne déjà un playbook réutilisable en tant que tel (un playbook marqué "modèle"). La nouvelle entité de ce chantier (bibliothèque de **messages texte** par type de playbook) doit être nommée différemment pour éviter la confusion — ex. `playbook_message_templates`, pas `playbook_templates`.
- `playbooks.eligibility_criteria` (JSONB, `{operator, conditions}`) est déjà le mécanisme de sélection des comptes éligibles — réutilisé tel quel pour déterminer les "comptes à risque du playbook" (FR-001), pas de nouveau moteur d'éligibilité.
- Les Edge Functions suivent le pattern obligatoire : CORS → Auth (`_shared/auth.ts`, JWT ES256) → Parse → Tenant (`organization_id`) → Logic → Persist → Response (<5s). Toute nouvelle fonction REST doit s'y conformer.
- Aucune fonction d'export CSV n'existe actuellement dans `supabase/functions/`. Ce sera une nouvelle Edge Function.

## Decision: nommage de la nouvelle table de templates de message

- **Decision**: `playbook_message_templates` (colonnes : `id`, `organization_id`, `playbook_type` ou `template_category` — aligné sur `VALID_TEMPLATE_CATEGORIES` existant —, `body`, `is_active`, `is_default`, `created_at`, `updated_at`).
- **Rationale**: évite la collision avec le concept existant `playbooks.playbook_type = 'template'`. Réutilise `VALID_TEMPLATE_CATEGORIES` comme clé d'association plutôt qu'une nouvelle taxonomie de types.
- **Alternatives considered**: étendre `playbooks` avec une colonne `message_body` — rejeté car un type de playbook (catégorie) doit pouvoir avoir plusieurs templates gérés indépendamment de toute instance de playbook, et parce que les templates sont un concept produit (bibliothèque), pas une instance de playbook.

## Decision: génération du CSV — synchrone vs asynchrone

- **Decision**: génération synchrone dans une Edge Function REST (`GET`/`POST /playbook-export`), retournant directement le fichier CSV en réponse, sans étape de job asynchrone.
- **Rationale**: le contrat Edge Function impose une réponse <5s. Le volume réaliste (comptes éligibles à un playbook, typiquement quelques centaines à low-thousands per organisation en usage SaaS B2B) reste compatible avec une génération synchrone. Correspond à SC-001 (<10s perçues côté utilisateur, marge incluant latence réseau).
- **Alternatives considered**: génération asynchrone avec stockage temporaire et lien de téléchargement — rejeté comme sur-ingénierie pour le V1 (pas de justification d'infrastructure additionnelle sans preuve de volume la nécessitant — cf. Anti-surengineering CLAUDE.md). À reconsidérer si un compte organisation dépasse largement les volumes observés.

## Decision: résolution des merge-tags — PII en transit <500ms

- **Decision**: si un merge-tag nécessite une donnée qui n'existe qu'au sein d'un système externe (aucun cas identifié à ce stade — `{company}` est déjà un nom d'entreprise non-PII stocké côté `accounts`/`hubspot_companies`, `{amount_at_risk}` et `{days_since_last_activity}` sont dérivés de données déjà internes), la résolution se fait entièrement en mémoire dans le handler de la requête, sans écriture en base ni en cache, avant sérialisation du CSV.
- **Rationale**: respecte la contrainte Zero-PII et la fenêtre <500ms énoncée dans le besoin — en pratique aucune donnée personnelle n'a besoin de transiter du tout pour les 3 merge-tags cités, donc la contrainte de 500ms est une garde-fou pour de futurs merge-tags, pas un mécanisme actif pour le scope V1.
- **Alternatives considered**: aucune — pas de merge-tag PII identifié dans le besoin exprimé. Documenté ici pour que tout ajout futur de merge-tag respecte explicitement cette contrainte.

## Decision: format et distribution du CSV

- **Decision**: encodage UTF-8, séparateur virgule, une ligne d'en-tête (`account_ref`, `mrr_at_risk_cents`, `message`), échappement standard RFC 4180 pour les champs contenant des virgules/guillemets/retours à la ligne (le message texte peut contenir des virgules).
- **Rationale**: format universellement compatible avec les imports Brevo/Lemlist/ActiveCampaign (volet 3) et les tableurs.
- **Alternatives considered**: JSON — rejeté, le besoin exprime explicitement "export CSV".

## Decision: livrable documentaire (volet 3)

- **Decision**: fichier markdown de référence (`specs/001-playbooks-export-csv/merge-tags-mapping.md` ou équivalent sous `docs/`), listant chaque merge-tag, sa source de donnée, sa valeur de repli, et pour chaque ESP (Brevo, Lemlist, ActiveCampaign) le nom du merge-tag natif ou la syntaxe d'import correspondante.
- **Rationale**: le besoin précise explicitement "documentation de mapping ... pas du code". Aucune tâche de développement (pas d'intégration API ESP) ne doit être générée pour ce volet.
- **Alternatives considered**: page frontend dédiée — rejeté, hors scope backend de ce chantier et non demandé.

## Resolved NEEDS CLARIFICATION

Aucun `[NEEDS CLARIFICATION]` n'a été laissé dans le spec — toutes les décisions techniques ambiguës ont été tranchées ci-dessus avec justification, à valider en relecture humaine avant `/speckit-tasks`.
