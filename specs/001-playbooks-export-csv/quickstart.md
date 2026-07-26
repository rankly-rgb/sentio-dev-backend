# Quickstart: Playbooks actionnables — export CSV & bibliothèque de templates

## Prérequis

- Organisation de test avec au moins un playbook `active` ayant des comptes éligibles (`eligibility_criteria` matchant des comptes existants).
- Au moins un `playbook_message_templates` actif pour la `template_category` de ce playbook.

## Scénario 1 — Export réussi (US1, FR-001 à FR-005)

1. Authentifier un utilisateur de l'organisation de test (JWT ES256).
2. `GET /playbook-export?playbook_id={id}` sur un playbook actif avec comptes éligibles.
3. Vérifier : réponse `200`, `Content-Type: text/csv`, une ligne par compte éligible, colonnes `account_ref,mrr_at_risk_cents,message`.
4. Vérifier : aucun merge-tag brut (`{...}`) ne subsiste dans la colonne `message`.
5. Vérifier (contrôle Zero-PII) : `grep -iE "@|email|phone|\\bip\\b"` sur le corps de la réponse ne retourne rien de pertinent lié à une personne.

## Scénario 2 — Playbook sans compte éligible (Edge Case)

1. `GET /playbook-export?playbook_id={id}` sur un playbook actif sans compte éligible actuellement.
2. Vérifier : réponse `200`, CSV avec en-tête seul, pas d'erreur.

## Scénario 3 — Gestion de la bibliothèque de templates (US2, FR-006 à FR-009)

1. Créer un template pour une `template_category` donnée via l'endpoint CRUD templates.
2. Réexécuter le Scénario 1 sur un playbook de cette catégorie → le message généré utilise le contenu du nouveau template.
3. Désactiver ce template (`is_active = false`) → réexécuter l'export → le template désactivé n'est plus utilisé.
4. Créer un deuxième template actif pour la même catégorie sans le marquer `is_default` → vérifier que le comportement de sélection reste déterministe (documenté dans Assumptions du spec).

## Scénario 4 — Absence de template pour la catégorie (Edge Case, FR-012)

1. `GET /playbook-export?playbook_id={id}` sur un playbook d'une catégorie sans aucun `playbook_message_templates` actif.
2. Vérifier : réponse `200` (pas d'échec), colonne `message` indique explicitement l'absence de template plutôt qu'une chaîne vide.

## Scénario 5 — Documentation de mapping merge-tags (US3)

1. Ouvrir le fichier de documentation livré (ex. `merge-tags-mapping.md`).
2. Vérifier que les 3 merge-tags cités dans le besoin (`{company}`, `{amount_at_risk}`, `{days_since_last_activity}`) y sont documentés avec leur signification.
3. Vérifier qu'au moins 2 ESP parmi Brevo, Lemlist, ActiveCampaign ont un format d'import documenté et exploitable sans interprétation supplémentaire.

## Validation Zero-PII globale

Pour chaque scénario ci-dessus impliquant une réponse HTTP ou un log, confirmer l'absence de PII (email, nom de personne, téléphone, IP) — cf. constitution `.specify/memory/constitution.md` § Zero-PII.
