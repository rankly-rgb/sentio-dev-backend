# Feature Specification: Boucle de preuve de résultat des playbooks (backend)

**Feature Branch**: `feat/playbook-outcome-tracking`

**Created**: 2026-07-26

**Status**: Draft

**Input**: User description: "Suivi d'exécution des playbooks côté backend : (1) bouton 'marquer comme exécuté' avec horodatage et fenêtre d'attribution configurable ; (2) détection automatique de résolution en réutilisant le sync Stripe existant (invoice paid), pas un nouveau pipeline ; (3) lien traçable optionnel par playbook exécuté, avec redirection et log de clic horodaté, sans jamais stocker d'email ni d'identifiant personnel — uniquement stripe_customer_id et organization_id."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Marquer un playbook comme exécuté (Priority: P1)

Un CSM, après avoir agi manuellement sur un compte (ex: envoyé le message généré par l'export CSV du chantier playbooks), marque l'exécution du playbook comme "exécutée" pour ce compte, ce qui horodate l'action et ouvre une fenêtre d'attribution pendant laquelle une résolution ultérieure (ex: facture payée) pourra être reliée à cette action.

**Why this priority**: Sans cette action, aucune preuve de résultat n'est possible — c'est le point d'entrée de toute la boucle de preuve.

**Independent Test**: Peut être testé en marquant un playbook comme exécuté pour un compte donné et en vérifiant qu'un horodatage d'exécution est enregistré et qu'une fenêtre d'attribution (durée configurable) est associée à cette exécution.

**Acceptance Scenarios**:

1. **Given** un playbook actif avec un compte éligible non encore marqué exécuté, **When** le CSM marque l'exécution comme faite, **Then** l'exécution est horodatée et la fenêtre d'attribution du playbook (ou une valeur par défaut) lui est associée.
2. **Given** une exécution déjà marquée comme faite, **When** le CSM tente de la marquer à nouveau, **Then** le système ne crée pas de doublon incohérent (comportement idempotent ou création d'une nouvelle tentative distincte — voir Assumptions).
3. **Given** un playbook dont la fenêtre d'attribution n'a pas été explicitement configurée, **When** une exécution est marquée, **Then** une fenêtre d'attribution par défaut raisonnable s'applique.

---

### User Story 2 - Détection automatique de résolution via le sync Stripe existant (Priority: P1)

Le système détecte automatiquement qu'une exécution de playbook a été suivie d'une résolution positive (ex: une facture précédemment en souffrance est payée) en réutilisant les événements déjà captés par le sync/webhook Stripe existant, sans introduire de nouveau pipeline de données.

**Why this priority**: C'est ce qui transforme une simple action manuelle (US1) en preuve de résultat mesurable — la valeur business du chantier.

**Independent Test**: Peut être testé en marquant une exécution comme faite pour un compte ayant une facture en souffrance, puis en simulant/déclenchant l'événement `invoice.paid` déjà traité par le webhook Stripe existant pour ce compte dans la fenêtre d'attribution, et en vérifiant que l'exécution est mise à jour comme résolue.

**Acceptance Scenarios**:

1. **Given** une exécution de playbook marquée exécutée avec une fenêtre d'attribution active, **When** un événement `invoice.paid` est reçu pour le compte concerné dans cette fenêtre, **Then** l'exécution est marquée comme résolue (conversion) avec un horodatage de résolution.
2. **Given** une exécution de playbook marquée exécutée, **When** un événement `invoice.paid` est reçu pour le compte concerné mais après l'expiration de la fenêtre d'attribution, **Then** l'exécution n'est pas automatiquement marquée comme résolue par cet événement.
3. **Given** un événement `invoice.paid` reçu pour un compte sans exécution de playbook active en attente d'attribution, **When** le webhook le traite, **Then** le comportement existant du sync Stripe n'est pas modifié (pas de régression sur le traitement standard des factures).

---

### User Story 3 - Lien traçable optionnel avec log de clic (Priority: P3)

Un CSM inclut, dans le message d'un playbook exécuté, un lien traçable optionnel. Lorsque le destinataire clique sur ce lien, le système enregistre un horodatage de clic associé au playbook exécuté et redirige vers la destination prévue, sans jamais stocker d'email ni d'identifiant personnel — uniquement `stripe_customer_id` et `organization_id`.

**Why this priority**: C'est un signal d'engagement complémentaire (plus fin que la seule résolution Stripe), mais la boucle de preuve fonctionne déjà sans lui via US1+US2 — c'est un enrichissement, pas un prérequis.

**Independent Test**: Peut être testé en générant un lien traçable pour une exécution de playbook, en simulant un accès à ce lien, et en vérifiant qu'un log de clic horodaté est créé (avec uniquement `stripe_customer_id`/`organization_id`) et que la redirection fonctionne vers la bonne destination.

**Acceptance Scenarios**:

1. **Given** une exécution de playbook pour laquelle un lien traçable a été généré, **When** ce lien est visité, **Then** un log de clic horodaté est créé et l'utilisateur est redirigé vers la destination prévue.
2. **Given** un log de clic créé, **When** on inspecte son contenu, **Then** il ne contient que `stripe_customer_id`, `organization_id`, un horodatage, et une référence à l'exécution — jamais d'email, nom, téléphone ou IP.
3. **Given** un lien traçable généré pour une exécution, **When** il est visité plusieurs fois, **Then** chaque visite produit un log de clic distinct (pas de déduplication qui masquerait un signal d'engagement répété).

---

### Edge Cases

- Que se passe-t-il si un événement `invoice.paid` concerne un compte ayant plusieurs exécutions de playbook actives en attente d'attribution simultanément (ex: deux playbooks différents exécutés récemment sur le même compte) ? Le système doit attribuer la résolution de façon non-ambiguë (ex: toutes les exécutions en fenêtre active sont marquées résolues, ou seule la plus récente — à trancher en plan technique, cf. Assumptions).
- Que se passe-t-il si la fenêtre d'attribution est modifiée par un utilisateur après qu'une exécution a déjà été marquée exécutée ? La fenêtre déjà associée à cette exécution reste-t-elle figée, ou suit-elle la nouvelle configuration ? (voir Assumptions)
- Que se passe-t-il si le lien traçable est visité après la suppression ou l'archivage du playbook associé ? Le clic doit rester enregistrable et la redirection doit continuer à fonctionner tant que l'exécution existe.
- Que se passe-t-il si l'événement `invoice.paid` reçu correspond à un montant très inférieur au montant à risque initial (ex: facture partielle) ? Cette spec ne définit pas de seuil de matching par montant — toute facture payée du compte dans la fenêtre suffit à déclencher la détection (voir Assumptions).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Le système DOIT permettre à un utilisateur autorisé de marquer une exécution de playbook comme "exécutée" pour un compte donné, avec horodatage automatique.
- **FR-002**: Chaque playbook DOIT pouvoir avoir une fenêtre d'attribution configurable (durée en jours) déterminant combien de temps après le marquage "exécuté" une résolution peut lui être automatiquement attribuée.
- **FR-003**: En l'absence de configuration explicite de fenêtre d'attribution pour un playbook, une valeur par défaut DOIT s'appliquer.
- **FR-004**: Le système DOIT détecter automatiquement une résolution positive d'une exécution de playbook lorsqu'un événement de facture payée (`invoice.paid`) est reçu pour le compte concerné, dans la fenêtre d'attribution active, en réutilisant le traitement Stripe déjà existant — sans introduire de nouveau mécanisme de synchronisation de données Stripe.
- **FR-005**: Le système NE DOIT PAS modifier le comportement existant du traitement des événements `invoice.paid` pour les comptes sans exécution de playbook en attente d'attribution.
- **FR-006**: Le système DOIT permettre de générer, de façon optionnelle, un lien traçable associé à une exécution de playbook spécifique.
- **FR-007**: Lorsqu'un lien traçable est visité, le système DOIT enregistrer un log de clic horodaté et rediriger vers la destination prévue.
- **FR-008**: Le log de clic NE DOIT JAMAIS contenir d'email, de nom de personne, de téléphone ou d'adresse IP — uniquement `stripe_customer_id`, `organization_id`, un horodatage, et une référence à l'exécution de playbook.
- **FR-009**: Toute donnée créée ou modifiée par cette fonctionnalité (exécution marquée, résolution détectée, log de clic) DOIT être scopée par `organization_id`.
- **FR-010**: Le système DOIT gérer explicitement le cas où plusieurs exécutions actives sont en attente d'attribution pour le même compte au moment d'un événement `invoice.paid`.

### Key Entities *(include if feature involves data)*

- **Exécution de playbook** (`playbook_executions`, existant) : enrichi conceptuellement d'un état "marqué exécuté avec horodatage" et d'une fenêtre d'attribution active, permettant de relier une résolution ultérieure. Cette spec ne redéfinit pas l'entité existante dans son ensemble, seulement son usage pour la boucle de preuve.
- **Fenêtre d'attribution** : durée configurable (par playbook, avec valeur par défaut) déterminant la période pendant laquelle une résolution externe peut être attribuée à une exécution marquée exécutée.
- **Lien traçable** : référence unique associée à une exécution de playbook, permettant redirection + log de clic.
- **Log de clic** : enregistrement horodaté d'une visite d'un lien traçable, contenant uniquement `stripe_customer_id`, `organization_id`, horodatage, référence à l'exécution.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Un CSM peut marquer une exécution de playbook comme exécutée en une seule action, avec horodatage visible immédiatement.
- **SC-002**: 100% des résolutions automatiquement détectées via `invoice.paid` dans la fenêtre d'attribution sont correctement rattachées à l'exécution de playbook correspondante, sans intervention manuelle.
- **SC-003**: Le traitement existant des événements `invoice.paid` pour les comptes sans exécution en attente reste inchangé (0 régression mesurée sur le comportement actuel).
- **SC-004**: Un audit du contenu de tout log de clic ne révèle aucune donnée personnelle — vérifiable par contrôle automatisé sur 100% des logs.
- **SC-005**: Un lien traçable généré redirige correctement vers sa destination dans 100% des visites, y compris après plusieurs clics répétés sur le même lien.

## Assumptions

- La "détection automatique de résolution" se limite à la réception d'un événement `invoice.paid` pour le compte concerné pendant la fenêtre d'attribution — aucun matching par montant exact n'est requis par cette spec (une facture payée, quel que soit son montant, suffit à déclencher la détection).
- Si plusieurs exécutions actives sont en attente d'attribution pour le même compte au moment de l'événement, toutes sont marquées résolues (comportement le plus simple, évite un choix arbitraire de priorité) — décision technique à documenter et confirmer en plan.
- La fenêtre d'attribution associée à une exécution est figée au moment où l'exécution est marquée exécutée (elle ne suit pas une modification ultérieure de la configuration du playbook), pour garantir la cohérence historique des mesures de résultat.
- Le marquage "exécuté" est idempotent par exécution : une exécution déjà marquée ne peut pas être re-marquée avec un nouvel horodatage qui écraserait le premier (le comportement exact — no-op vs erreur explicite — sera tranché en plan technique).
- La valeur par défaut de la fenêtre d'attribution est de 14 jours, par cohérence avec le cooldown déjà retenu pour les alertes dans le chantier A (scoring V2) — à confirmer ou ajuster explicitement en plan technique si un choix différent est justifié pour ce contexte spécifique.
- Le "lien traçable" est un lien interne au produit (redirection gérée par le backend Sentio), pas un lien tiers — cette spec ne couvre pas l'intégration avec un raccourcisseur d'URL externe.
- Cette spec couvre uniquement les parties backend de la boucle de preuve de résultat — l'affichage UI du bouton "marquer comme exécuté" et la visualisation des résultats sont hors scope (traités séparément côté frontend).
