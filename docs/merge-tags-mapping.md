# Merge-tags — mapping vers les ESP (Brevo, Lemlist, ActiveCampaign)

Ce document liste les merge-tags résolus par `playbook-export` (`supabase/functions/_shared/merge-tags.ts`) et leur équivalent d'import pour les principaux ESP (Email Service Providers) utilisés par les clients Sentio. Il ne couvre aucune intégration API — Sentio exporte un CSV avec le message déjà résolu ; c'est le CSM qui importe ce CSV dans l'ESP de son choix.

## Merge-tags disponibles

| Merge-tag Sentio | Signification | Source de donnée | Valeur de repli si absente |
|---|---|---|---|
| `{company}` | Nom de l'entreprise cliente (non-PII — nom de société, pas de personne) | `accounts.display_name` | `"this account"` |
| `{amount_at_risk}` | Montant de MRR à risque, formaté en devise (en-US) | `accounts.mrr_cents` | `"$0.00"` |
| `{days_since_last_activity}` | Nombre de jours depuis le dernier événement d'usage produit connu | Dernier `usage_events.event_date` du compte | `"unknown"` |

Ces merge-tags sont résolus **avant** l'export — le CSV livré par `playbook-export` ne contient plus aucun `{...}` brut, uniquement le texte final prêt à être importé.

## Format d'import par ESP

Sentio exporte un CSV avec les colonnes fixes `account_ref, mrr_at_risk_cents, message` — la colonne `message` contient déjà le texte final (merge-tags résolus côté Sentio). Le tableau ci-dessous documente, pour référence, comment chaque ESP aurait nativement noté ces mêmes variables si vous deviez les recréer manuellement dans un template de séquence de cet ESP (ex: pour personnaliser davantage après import) :

| Merge-tag Sentio | Brevo | Lemlist | ActiveCampaign |
|---|---|---|---|
| `{company}` | `{{ contact.COMPANY }}` | `{{companyName}}` | `%COMPANY%` |
| `{amount_at_risk}` | `{{ contact.AMOUNT_AT_RISK }}` (attribut personnalisé à créer) | `{{amountAtRisk}}` (variable personnalisée) | `%AMOUNT_AT_RISK%` (champ personnalisé à créer) |
| `{days_since_last_activity}` | `{{ contact.DAYS_INACTIVE }}` (attribut personnalisé à créer) | `{{daysInactive}}` (variable personnalisée) | `%DAYS_INACTIVE%` (champ personnalisé à créer) |

> Les noms d'attribut/variable/champ personnalisé (`AMOUNT_AT_RISK`, `daysInactive`, etc.) sont des conventions de nommage suggérées, pas des noms réservés par l'ESP — à créer dans l'ESP si vous souhaitez ré-exploiter ces valeurs dans un template natif de l'ESP plutôt que d'utiliser directement la colonne `message` déjà résolue par Sentio. Vérifier la syntaxe exacte contre la documentation à jour de chaque ESP avant utilisation en production, celle-ci pouvant évoluer indépendamment de Sentio.

## Import du CSV

1. Exporter via `GET /playbook-export?playbook_id={id}`.
2. Importer le fichier CSV directement dans l'outil d'emailing/séquençage (Brevo, Lemlist, ActiveCampaign, ou tout autre outil acceptant un import CSV) comme liste de contacts/comptes à cibler, `message` étant la colonne à utiliser comme corps de communication déjà personnalisé.
3. `account_ref` (`stripe_customer_id`) permet de retrouver le compte côté Sentio si besoin de recouper — ce n'est jamais un identifiant à afficher au destinataire final.

## Garantie Zero-PII

Aucun des trois merge-tags ci-dessus ne repose sur une donnée personnelle (email, nom de personne, téléphone, IP) — `{company}` désigne le nom de l'entreprise cliente, pas un contact individuel. Le CSV exporté par `playbook-export` ne contient donc jamais de PII, conformément à FR-008/SC-004 (`specs/001-playbooks-export-csv/spec.md`).
