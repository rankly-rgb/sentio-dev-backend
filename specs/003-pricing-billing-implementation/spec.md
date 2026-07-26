# Feature Specification: Mise en œuvre technique du pricing (backend)

**Feature Branch**: `feat/pricing-billing-implementation`

**Created**: 2026-07-26

**Status**: Draft

**Input**: User description: "Mise en œuvre technique de la grille tarifaire (Free / Growth / Scale / Enterprise), facturée au nombre de comptes actifs suivis, pas par siège. Trois volets : (1) logique de gating par palier selon le nombre de comptes actifs suivis, avec alerte à l'approche de la limite ; (2) intégration Stripe Billing pour la facturation de Sentio lui-même (abonnements, changement de palier, annulation) ; (3) parcours self-serve par défaut pour Free/Growth, avec proposition d'appel affichée spécifiquement au moment de la connexion de la clé Stripe ; RDV obligatoire et sans alternative self-serve pour Scale et Enterprise. Le chantier A (scoring V2) étant confirmé livré, la bascule RDV-optionnel pour Free/Growth peut être traitée comme active par défaut, pas derrière un feature flag."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Gating par palier selon le nombre de comptes actifs suivis (Priority: P1)

Une organisation cliente approche ou dépasse la limite de comptes actifs suivis autorisée par son palier tarifaire (Free / Growth / Scale / Enterprise). Le système alerte l'organisation à l'approche de la limite et applique un gating cohérent avec son palier lorsque la limite est atteinte ou dépassée.

**Why this priority**: C'est le socle de toute la grille tarifaire — sans logique de gating fiable, la facturation par nombre de comptes n'a pas de base technique pour être appliquée ou faire respecter les paliers.

**Independent Test**: Peut être testé en faisant croître le nombre de comptes actifs suivis d'une organisation de test jusqu'à et au-delà de la limite de son palier, et en vérifiant qu'une alerte se déclenche à l'approche puis qu'un gating cohérent s'applique au dépassement.

**Acceptance Scenarios**:

1. **Given** une organisation dont le nombre de comptes actifs suivis approche la limite de son palier (ex: 90% de la limite), **When** ce seuil est franchi, **Then** une alerte est déclenchée à destination de l'organisation.
2. **Given** une organisation dont le nombre de comptes actifs suivis dépasse la limite de son palier, **When** le système évalue le gating, **Then** le comportement de gating défini pour ce dépassement s'applique (voir Assumptions pour la nature exacte du gating au V1).
3. **Given** une organisation dont le nombre de comptes actifs suivis redescend sous la limite (ex: comptes churnés), **When** le système réévalue le gating, **Then** l'alerte et le gating se lèvent en conséquence.

---

### User Story 2 - Intégration Stripe Billing pour la facturation de Sentio (Priority: P1)

Sentio facture ses organisations clientes via une intégration Stripe Billing dédiée à sa propre facturation (distincte de l'intégration Stripe déjà existante qui lit les données de facturation des clients de l'organisation). Cette intégration gère la création d'abonnement, le changement de palier, et l'annulation.

**Why this priority**: Sans cette intégration, le gating (US1) n'a aucun mécanisme de facturation réel associé — c'est ce qui rend la grille tarifaire opérationnelle plutôt que déclarative.

**Independent Test**: Peut être testé en créant un abonnement Stripe Billing pour une organisation de test sur un palier donné, en changeant de palier, puis en annulant l'abonnement, et en vérifiant que l'état de l'organisation (palier actif, statut d'abonnement) reflète correctement chaque étape.

**Acceptance Scenarios**:

1. **Given** une nouvelle organisation sur le palier Free, **When** elle souscrit à un palier payant (Growth/Scale/Enterprise) via Stripe Billing, **Then** un abonnement Stripe est créé et le palier de l'organisation est mis à jour en conséquence.
2. **Given** une organisation avec un abonnement actif sur un palier donné, **When** elle change de palier (upgrade ou downgrade), **Then** l'abonnement Stripe est mis à jour et le palier effectif de l'organisation change en cohérence avec la politique de proration/effet immédiat retenue (voir Assumptions).
3. **Given** une organisation avec un abonnement actif, **When** elle annule son abonnement, **Then** l'abonnement Stripe est annulé et l'organisation repasse sur le palier Free (ou un état "annulé" cohérent — voir Assumptions) à l'échéance appropriée.
4. **Given** un événement Stripe Billing reçu (ex: paiement échoué, abonnement annulé côté Stripe), **When** le webhook correspondant est traité, **Then** l'état de l'organisation est mis à jour en cohérence, sans intervention manuelle.

---

### User Story 3 - Parcours self-serve par défaut (Free/Growth) avec proposition d'appel ciblée (Priority: P2)

Une organisation souscrivant à un palier Free ou Growth suit un parcours entièrement self-serve, sans RDV obligatoire. Au moment précis où elle connecte sa clé Stripe (l'intégration Stripe qui lit les données de ses propres clients, pas la facturation Sentio), une proposition d'appel est affichée, sans bloquer la poursuite du parcours self-serve. Pour les paliers Scale et Enterprise, un RDV est obligatoire, sans alternative self-serve.

**Why this priority**: C'est ce qui détermine l'expérience d'acquisition — moins critique techniquement que US1/US2 (le gating et la facturation fonctionnent indépendamment de cette story), mais nécessaire pour que le produit soit vendable en self-serve sur les paliers d'entrée.

**Independent Test**: Peut être testé en simulant une souscription Free/Growth de bout en bout sans aucune interaction humaine obligatoire (hors la proposition d'appel non-bloquante au moment de la connexion Stripe), puis en simulant une tentative de souscription Scale/Enterprise et en vérifiant qu'aucun chemin self-serve n'existe pour finaliser cette souscription.

**Acceptance Scenarios**:

1. **Given** une organisation en cours de souscription à un palier Free ou Growth, **When** elle connecte sa clé Stripe (intégration de lecture des données clients, pas la facturation Sentio), **Then** une proposition d'appel est affichée à ce moment précis, sans empêcher la poursuite du parcours self-serve.
2. **Given** une organisation en cours de souscription à un palier Free ou Growth, **When** elle décline la proposition d'appel, **Then** elle peut poursuivre et finaliser sa souscription entièrement en self-serve.
3. **Given** une organisation souhaitant souscrire au palier Scale ou Enterprise, **When** elle tente de finaliser une souscription, **Then** aucun chemin self-serve de finalisation n'est disponible — un RDV est requis.

---

### Edge Cases

- Que se passe-t-il si une organisation Scale/Enterprise (RDV obligatoire) dépasse elle aussi sa limite de comptes actifs suivis ? La logique de gating (US1) s'applique de façon identique quel que soit le palier — seul le parcours de souscription initial (US3) diffère selon le palier.
- Que se passe-t-il si le paiement Stripe Billing d'une organisation échoue (carte refusée) ? L'organisation doit être notifiée et un état de grâce cohérent doit s'appliquer avant tout gating punitif (voir Assumptions) — pas de coupure immédiate et silencieuse.
- Que se passe-t-il si une organisation change de palier alors qu'elle est déjà au-dessus de la limite de comptes actifs du nouveau palier choisi (downgrade impossible en l'état) ? Le système doit empêcher ou avertir explicitement de cette incohérence avant de finaliser le downgrade.
- Que se passe-t-il si l'intégration Stripe Billing (facturation Sentio) et l'intégration Stripe existante (lecture des données clients de l'organisation) sont confondues techniquement ? Cette spec exige explicitement deux intégrations Stripe strictement séparées (comptes Stripe distincts, clés distinctes) — voir Assumptions et research.md du plan technique.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Le système DOIT compter, pour chaque organisation, le nombre de comptes actifs suivis (défini comme dans le reste du produit — comptes avec MRR non nul, cohérent avec la convention déjà utilisée ailleurs).
- **FR-002**: Chaque palier tarifaire (Free, Growth, Scale, Enterprise) DOIT avoir une limite de comptes actifs suivis configurée.
- **FR-003**: Le système DOIT déclencher une alerte lorsqu'une organisation approche la limite de comptes actifs suivis de son palier (seuil d'approche configurable, ex: 90%).
- **FR-004**: Le système DOIT appliquer un comportement de gating défini lorsqu'une organisation dépasse la limite de comptes actifs suivis de son palier.
- **FR-005**: Le système DOIT intégrer Stripe Billing pour la facturation de Sentio auprès de ses organisations clientes, strictement séparée de l'intégration Stripe existante utilisée pour lire les données de facturation des clients de chaque organisation.
- **FR-006**: Le système DOIT permettre la création d'un abonnement Stripe Billing lors de la souscription d'une organisation à un palier payant.
- **FR-007**: Le système DOIT permettre le changement de palier d'une organisation (upgrade ou downgrade) via Stripe Billing, en répercutant le changement sur le palier effectif de l'organisation.
- **FR-008**: Le système DOIT permettre l'annulation d'un abonnement Stripe Billing par l'organisation, avec retour de l'organisation à un état cohérent (palier Free ou état "annulé" — voir Assumptions).
- **FR-009**: Le système DOIT traiter les événements webhook Stripe Billing pertinents (paiement échoué, annulation côté Stripe, etc.) pour maintenir l'état de l'organisation synchronisé sans intervention manuelle.
- **FR-010**: Le parcours de souscription aux paliers Free et Growth DOIT être entièrement self-serve par défaut (actif, pas derrière un feature flag).
- **FR-011**: Le système DOIT afficher une proposition d'appel au moment où une organisation en parcours Free/Growth connecte sa clé Stripe (intégration de lecture des données clients), sans bloquer la poursuite du parcours self-serve.
- **FR-012**: Le parcours de souscription aux paliers Scale et Enterprise NE DOIT PAS proposer de chemin self-serve de finalisation — un RDV est obligatoire.
- **FR-013**: Le système DOIT empêcher ou avertir explicitement lorsqu'un downgrade de palier rendrait une organisation immédiatement incohérente avec la nouvelle limite de comptes actifs suivis.

### Key Entities *(include if feature involves data)*

- **Palier tarifaire (Plan Tier)**: Free, Growth, Scale, Enterprise — chacun avec une limite de comptes actifs suivis et une politique de parcours de souscription (self-serve ou RDV obligatoire).
- **Abonnement Sentio (Sentio Subscription)**: représente la relation de facturation entre une organisation et Sentio via Stripe Billing — distinct de toute donnée d'abonnement appartenant aux clients de l'organisation elle-même.
- **Alerte de limite de comptes actifs**: notification déclenchée à l'approche/au dépassement de la limite du palier d'une organisation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Une organisation approchant la limite de son palier reçoit une alerte avant tout dépassement, dans 100% des cas testés.
- **SC-002**: Une organisation peut souscrire, changer de palier, ou annuler son abonnement Growth/Free entièrement en self-serve, sans intervention manuelle de l'équipe Sentio.
- **SC-003**: 0% des tentatives de souscription self-serve ne peuvent finaliser un palier Scale ou Enterprise sans passer par un RDV.
- **SC-004**: 100% des événements Stripe Billing pertinents (paiement échoué, annulation) se répercutent sur l'état de l'organisation sans nécessiter de correction manuelle.
- **SC-005**: Aucune confusion opérationnelle entre les deux intégrations Stripe (facturation Sentio vs données clients de l'organisation) — vérifiable par revue technique (clés, comptes Stripe, webhooks strictement séparés).

## Assumptions

- "Comptes actifs suivis" est défini de façon cohérente avec l'usage déjà établi ailleurs dans le produit pour désigner un compte avec MRR non nul (comme documenté pour `total_mrr_cents` dans `docs/CHANGELOG_STABILITY.md`) — cette spec ne redéfinit pas cette notion, elle l'utilise comme base de comptage pour la facturation.
- Le gating au dépassement de limite, pour le V1, se limite à un blocage de l'ajout de nouveaux comptes suivis au-delà de la limite (pas de coupure d'accès aux comptes déjà suivis, pas de suppression de données) — un dépassement bloque la croissance, ne détruit pas l'existant. À confirmer/ajuster explicitement en plan technique si une politique différente est souhaitée.
- Un paiement Stripe Billing échoué déclenche un état de grâce (ex: 7 jours, aligné sur les pratiques Stripe standard) avant tout gating punitif — pas de coupure immédiate au premier échec de paiement.
- Un downgrade vers un palier dont la limite est déjà dépassée par le nombre actuel de comptes actifs est bloqué avec un message explicite, plutôt qu'autorisé silencieusement avec un état incohérent.
- L'annulation d'un abonnement payant ramène l'organisation au palier Free à l'échéance de la période déjà payée (pas de coupure immédiate mi-période), cohérent avec les pratiques standard de facturation SaaS.
- La bascule "RDV optionnel pour Free/Growth" (mentionnée dans le besoin comme conditionnée à la livraison du chantier A) est traitée comme active par défaut dans cette spec, sans feature flag — conformément à la confirmation que le chantier A est déjà livré et mergé sur `main`.
- Cette spec couvre les parties backend (gating, intégration Stripe Billing, webhooks, logique de parcours) — les écrans frontend de souscription/changement de palier et la prise de RDV elle-même (ex: intégration calendaire) sont hors scope de cette spec.
- L'intégration Stripe Billing pour la facturation de Sentio nécessite un compte Stripe et des identifiants strictement distincts de l'intégration Stripe existante (`STRIPE_SECRET_KEY`, `STRIPE_CLIENT_ID`, OAuth) qui sert à lire les données de facturation des clients de chaque organisation — ces deux intégrations ne doivent jamais partager de compte, de clé, ni de webhook.
