# Feature Specification: Playbooks actionnables — export CSV & bibliothèque de templates

**Feature Branch**: `feat/playbooks-export-csv`

**Created**: 2026-07-26

**Status**: Draft

**Input**: User description: "Système de playbooks actionnables exporté en CSV, sans stockage d'email (résolution à l'export uniquement, transit PII <500ms). Trois volets : (1) export CSV listant les comptes à risque du playbook, montant à risque et template de message texte prêt à copier ; (2) une bibliothèque de templates par type de playbook (payment recovery, churn risk, expansion opportunity...), stockée en base et gérable côté produit ; (3) une documentation de mapping des merge-tags (ex : {company}, {amount_at_risk}, {days_since_last_activity}) avec formats d'import prêts pour 2-3 ESP courants (Brevo, Lemlist, ActiveCampaign)."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Exporter un playbook en CSV prêt à l'emploi (Priority: P1)

Un CSM (Customer Success Manager) sélectionne un playbook actif et exporte la liste des comptes concernés sous forme de fichier CSV, contenant pour chaque compte le montant à risque et un message texte déjà personnalisé (merge-tags remplacés), prêt à copier dans son outil d'emailing.

**Why this priority**: C'est la valeur immédiate du chantier — sans cet export, aucune action concrète n'est possible. C'est le MVP.

**Independent Test**: Peut être testé en déclenchant l'export d'un playbook ayant au moins un compte éligible et en vérifiant que le fichier CSV produit contient les colonnes attendues, avec les merge-tags résolus et aucune donnée personnelle.

**Acceptance Scenarios**:

1. **Given** un playbook actif avec des comptes éligibles, **When** le CSM déclenche l'export, **Then** un fichier CSV est généré avec une ligne par compte : identifiant compte, montant à risque, message personnalisé.
2. **Given** un playbook sans aucun compte éligible actuellement, **When** le CSM déclenche l'export, **Then** un CSV vide (en-têtes seuls) est produit, sans erreur.
3. **Given** un export en cours de génération, **When** le fichier est produit, **Then** aucune colonne du CSV ne contient d'email, nom, téléphone ou adresse IP.

---

### User Story 2 - Gérer une bibliothèque de templates de message par type de playbook (Priority: P2)

Un responsable produit crée, modifie et désactive des templates de message texte associés à un type de playbook (payment recovery, churn risk, expansion opportunity, etc.), afin que chaque export CSV utilise automatiquement le template correspondant au type du playbook exporté.

**Why this priority**: Sans bibliothèque de templates gérable, le volet 1 (export) devrait utiliser un texte codé en dur — cette story rend le système utilisable en continu sans intervention technique.

**Independent Test**: Peut être testé en créant un template pour un type de playbook donné, puis en vérifiant qu'un export CSV pour ce type de playbook utilise bien ce template (et ses merge-tags) sans modification de code.

**Acceptance Scenarios**:

1. **Given** aucun template existant pour un type de playbook, **When** un responsable produit en crée un, **Then** ce template devient disponible pour tout export futur de ce type de playbook.
2. **Given** plusieurs templates actifs pour le même type de playbook, **When** un export est déclenché, **Then** le système utilise un template déterminé de façon prévisible (ex: le plus récent actif, ou celui marqué par défaut) — voir Assumptions.
3. **Given** un template désactivé, **When** un export est déclenché pour son type de playbook, **Then** ce template n'est pas utilisé.

---

### User Story 3 - Documentation de mapping des merge-tags pour import ESP (Priority: P3)

Un CSM ou un responsable produit consulte une documentation de référence listant les merge-tags disponibles (ex: `{company}`, `{amount_at_risk}`, `{days_since_last_activity}`), leur signification, et des instructions/formats prêts à l'emploi pour importer les templates dans 2 à 3 outils d'emailing courants (Brevo, Lemlist, ActiveCampaign).

**Why this priority**: C'est un livrable de référence qui facilite l'adoption du système par les équipes CS, mais le système d'export (P1) et de gestion de templates (P2) fonctionnent sans cette documentation.

**Independent Test**: Peut être vérifié en relisant le document de mapping et en confirmant qu'il couvre tous les merge-tags utilisés par les templates existants, avec un format d'import valide pour chaque ESP cité.

**Acceptance Scenarios**:

1. **Given** la liste des merge-tags supportés par le système, **When** on consulte la documentation, **Then** chaque merge-tag y est listé avec sa signification et un exemple de valeur résolue.
2. **Given** un ESP cité dans la documentation (Brevo, Lemlist ou ActiveCampaign), **When** on suit les instructions de mapping, **Then** le format de merge-tag propre à cet ESP est indiqué de façon exploitable sans interprétation supplémentaire.

---

### Edge Cases

- Que se passe-t-il si un compte éligible à l'export n'a pas de valeur pour un merge-tag donné (ex: `days_since_last_activity` inconnu) ? Le champ doit être résolu à une valeur de repli explicite plutôt que de laisser le merge-tag brut ou une valeur vide ambiguë dans le message.
- Que se passe-t-il si le type d'un playbook exporté ne correspond à aucun template actif dans la bibliothèque ? L'export ne doit pas échouer silencieusement — le message doit indiquer l'absence de template plutôt que produire un message vide.
- Que se passe-t-il si l'export est déclenché sur un très grand nombre de comptes (ex: plusieurs milliers) ? Le système doit rester utilisable (voir Success Criteria) et ne doit à aucun moment persister de PII pendant le traitement.
- Que se passe-t-il si deux comptes ont le même nom d'entreprise affiché ? Le CSV doit rester non-ambigu en s'appuyant sur l'identifiant compte, pas sur le nom affiché seul.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Le système DOIT permettre de déclencher l'export CSV d'un playbook donné, limité aux comptes actuellement éligibles à ce playbook.
- **FR-002**: Le CSV exporté DOIT contenir, pour chaque compte éligible : un identifiant de compte non-PII, le montant à risque (MRR concerné), et un message texte avec les merge-tags déjà résolus.
- **FR-003**: Le système DOIT résoudre les merge-tags (ex: `{company}`, `{amount_at_risk}`, `{days_since_last_activity}`) à la valeur réelle du compte au moment de l'export, sans persister ces valeurs résolues au-delà du fichier exporté.
- **FR-004**: Le système NE DOIT JAMAIS inclure d'email, nom de personne, téléphone ou adresse IP dans le CSV exporté ni dans aucune étape intermédiaire de sa génération.
- **FR-005**: Toute donnée à caractère personnel transitant temporairement pour la résolution des merge-tags (le cas échéant) DOIT être traitée en mémoire et non persistée, avec une durée de transit inférieure à 500ms.
- **FR-006**: Le système DOIT permettre à un utilisateur autorisé de créer un template de message associé à un type de playbook.
- **FR-007**: Le système DOIT permettre à un utilisateur autorisé de modifier ou désactiver un template existant.
- **FR-008**: Lorsqu'un export est déclenché pour un playbook d'un type donné, le système DOIT utiliser le template actif correspondant à ce type de playbook.
- **FR-009**: Chaque template DOIT être scopé à l'organisation qui l'a créé (un template d'une organisation n'est jamais visible ni utilisable par une autre organisation).
- **FR-010**: Le système DOIT fournir une documentation de référence listant l'ensemble des merge-tags disponibles, leur signification, et un format d'import prêt à l'emploi pour au moins 2 ESP parmi Brevo, Lemlist et ActiveCampaign.
- **FR-011**: Le système DOIT gérer explicitement le cas où un merge-tag n'a pas de valeur résolvable pour un compte donné (valeur de repli plutôt que tag brut ou champ vide).
- **FR-012**: Le système DOIT gérer explicitement le cas où aucun template actif n'existe pour le type de playbook exporté, sans échec silencieux.

### Key Entities *(include if feature involves data)*

- **Playbook Template**: Modèle de message texte réutilisable, associé à un type de playbook, appartenant à une organisation. Contient un corps de message avec merge-tags, un statut actif/inactif, et potentiellement un indicateur "par défaut" pour son type.
- **Export CSV** (concept, pas nécessairement une entité persistée): Résultat ponctuel d'une demande d'export pour un playbook donné — une ligne par compte éligible, avec montant à risque et message résolu.
- **Merge-tag**: Jeton de substitution (ex: `{company}`) correspondant à un attribut connu d'un compte, résolu à l'export.
- **Documentation de mapping ESP**: Livrable de référence (non-code) associant chaque merge-tag à son équivalent syntaxique dans chaque ESP supporté.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Un CSM peut générer un export CSV exploitable pour un playbook en moins de 10 secondes, quel que soit le nombre de comptes éligibles jusqu'à plusieurs milliers.
- **SC-002**: 100% des lignes d'un export CSV contiennent un message avec tous les merge-tags résolus (aucun `{...}` brut restant), sauf mention explicite de valeur de repli documentée.
- **SC-003**: Un audit du contenu de tout export CSV ne révèle aucune donnée personnelle (email, nom, téléphone, IP) — vérifiable par contrôle automatisé sur 100% des exports.
- **SC-004**: Un responsable produit peut créer et activer un nouveau template de playbook sans intervention technique, en moins de 5 minutes.
- **SC-005**: La documentation de mapping merge-tags/ESP permet à un CSM non-technique d'importer un template dans l'un des ESP cités sans assistance technique supplémentaire.

## Assumptions

- Les "comptes à risque du playbook" correspondent aux comptes actuellement éligibles au playbook selon ses critères d'éligibilité déjà existants dans le système (`eligibility_criteria`) — cette spec ne redéfinit pas ces critères.
- Le "montant à risque" correspond au MRR du compte concerné par le playbook (cohérent avec la définition déjà utilisée ailleurs dans le produit pour le MRR à risque).
- Lorsque plusieurs templates actifs existent pour un même type de playbook, le système utilise celui marqué explicitement "par défaut" pour ce type ; en l'absence de marquage, le plus récemment activé est utilisé. Ce comportement doit rester prévisible et documenté à l'utilisateur produit.
- L'export CSV est un livrable ponctuel généré à la demande (téléchargement), pas un flux automatique programmé — la planification récurrente d'export est hors scope de cette spec.
- La documentation de mapping merge-tags (volet 3) est un livrable purement documentaire (fichier de référence), pas une fonctionnalité applicative à développer — aucune intégration directe avec les API des ESP cités n'est requise par cette spec.
- Les valeurs de repli pour les merge-tags non résolvables suivent une convention explicite déjà en usage dans le produit (ex: `''` ou un texte de repli visible), à trancher au moment du plan technique.
- Le système existant de playbooks (`playbooks`, `playbook_executions`, `accounts`) reste la source de vérité pour les comptes éligibles et leurs métriques — cette spec ajoute la bibliothèque de templates et la capacité d'export, sans redéfinir le moteur d'éligibilité.
