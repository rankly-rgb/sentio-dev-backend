# CLAUDE.md — Sentio AI SaaS FR

## Source de vérité

| Priorité | Document |
|----------|----------|
| 1 | `docs/openspec.md` (prime sur tout) |
| 2 | `docs/test-spec/*` (comportement attendu) |
| 3 | `CLAUDE.md` (instructions Claude) |
| 4 | `docs/SENTIO_AI_SaaS_FR_Projet_Foundation.md` |

Historique des audits de stabilité : @docs/CHANGELOG_STABILITY.md

## Vue d'ensemble

Plateforme de Customer Intelligence pour éditeurs SaaS B2B francophones. Ingère Stripe (facturation), HubSpot (engagement) et usage produit pour calculer des scores de santé, détecter le churn et identifier les opportunités d'expansion.

**Architecture Zero-PII** : jamais d'email, nom, téléphone, IP. Uniquement identifiants anonymes (`stripe_customer_id`, `hubspot_company_id`) et métriques agrégées.

## Langue produit — English-only (en-US)

**IMPORTANT — décision produit actée** : le produit est intégralement en anglais (`en-US`), aucune exception. Ceci couvre tout contenu généré par le backend et consommé par un utilisateur final :
- Insights IA (`generate-insights`), recommandations d'action, AI summaries (`account-summary`)
- Templates d'emails (`weekly-digest`, `churn-alert`, `on-user-signup`, tout autre email transactionnel)
- Tout libellé, statut ou message d'erreur retourné par une Edge Function et affiché côté client

Dates au format US, séparateurs de milliers US, devise résolue depuis le compte Stripe connecté de l'org (jamais de symbole codé en dur type `€`). Il n'y a **aucune** plomberie multi-langue côté backend — pas de fallback FR, pas de détection de locale. Toute génération de contenu (prompts LLM inclus) DOIT produire de l'anglais directement, jamais de traduction a posteriori. Ce fichier CLAUDE.md et les commentaires de code restent en français (documentation interne), seule la sortie consommée par l'utilisateur est concernée.

## Stack

| Couche | Technologie |
|--------|-------------|
| DB | Supabase PostgreSQL + RLS |
| Backend | Supabase Edge Functions (Deno) |
| Frontend | Next.js 14 App Router |
| Langage | TypeScript 5.x (target ES5 — pas de `[...new Set()]`) |
| Styling | Tailwind CSS 3.x |
| Auth | @supabase/ssr (cookies, PKCE, ES256) |
| Tests | Vitest (614 tests) |
| CI/CD | GitHub Actions + Vercel |

**Phase actuelle** : setup/dev. Production intentionnellement inactif.

## Commandes

```bash
npm run dev          # Serveur Next.js local
npm run build        # Build production
npm run test         # Tests Vitest (614 tests)
npm run lint         # ESLint
npm run typecheck    # TypeScript check (tsc --noEmit)
npm run verify       # typecheck + lint + test + build (post-modification)
```

## Scoring SaaS — Engine V2/V3 (`_shared/scoring.ts`)

**IMPORTANT** : c'est le seul moteur de scoring actif (`model_version 'v3'` en base, branché depuis `calculate-scores/index.ts`). Les anciennes fonctions V1 (`calcHealthScore`, `calcChurnRiskScore`, `determineSegmentTypes` — formule `Health = Usage×35% + Financial×25% + Engagement×20% + Contract×20%` / `Churn = 100 - Health + additifs`) ont été supprimées le 2026-08-02 : zéro appelant en production, remplacées depuis par le moteur ci-dessous. Ne pas les réintroduire.

**Health Score** (`calcHealthScoreV3`) — 3 dimensions Stripe-only, poids org configurables (`organizations.scoring_weights`), défaut `payment_health=35 / revenue_dynamics=35 / contract_renewal=30` :

```
payment_health   = invoice_status_score(0.40) + payment_history_score(0.35) + dunning_score(0.25)
revenue_dynamics = mrr_trend_score(0.45) + contraction_score(0.35) + expansion_signal_score(0.20)
contract_renewal = billing_interval_score(0.30) + renewal_proximity_score(0.40) + tenure_score(0.30)
```

Principe fondateur : **« no data ≠ neutral data »**. Aucune fonction ne retourne un défaut numérique (50, 0…) pour un signal absent — l'absence est portée par `value: null` / `status: 'unavailable'`, exclue des moyennes (`combineWeightedSignals` — dimension entière `unavailable` si < 50% du poids interne dispo). Health Score composite = **aucune renormalisation dynamique entre dimensions** (poids fixes même si une dimension est indisponible — seul `health_score_max_points` diminue) ; statut `complete`/`partial`/`insufficient`, band `healthy`/`watch`/`at_risk`. `engagement` (HubSpot) et `product_usage` ne font PAS partie de ce modèle (dimensions v3-produit futures, hors scope).

**Churn Risk** (`calcChurnRiskV2` / `buildChurnSignals`) — additif, **découplé du Health Score** (plus de `100 - health`). 7 signaux déterministes (jamais de probabilité/confidence) : `invoice_overdue_15d`(35, CRITIQUE), `mrr_contraction_20pct_3mo`(30, CRITIQUE), `payment_failures_90d`(25, MAJEUR), `monthly_young_account`(20, MAJEUR), `annual_renewal_soon_with_contraction`(20, MAJEUR), `plan_downgrade_6mo`(10, MINEUR), `invoice_overdue_under_15d`(10, MINEUR). Un signal dont la donnée est absente est *skippé* (`value: null`), jamais compté comme non-déclenché. Band `low`/`watch`/`high` (seuils 25/50).

**Expansion Score** (`calcExpansionScoreV2`) — `seat_usage_pct` seul (via `stripe_product_mappings`), `null` explicite si non configuré. **Jamais de cap silencieux.**

**Segmentation V3** (`determineSegmentTypesV3`) — 8 segments (`en_expansion` conservé dans `SYSTEM_SEGMENT_TYPES`/CHECK constraint pour compat descendante mais plus jamais assigné — fusionné dans `champions`, qui exige désormais un signal d'expansion). Priorité décroissante, exclusif sauf `nouveaux` :
1. `nouveaux` — < 90 jours (non-exclusif)
2. `en_churn` — `mrr_cents = 0` **ou** `subscriptionCanceled`
3. `impayes` — factures en retard
4. `donnees_insuffisantes` — `health_score_status = 'insufficient'`
5. `en_danger_critique` — `churn_risk_band = 'high'`
6. `a_risque_leger` — `churn_risk_band = 'watch'`
7. `champions` — `health_score_band = 'healthy'` ET signal d'expansion présent
8. `stables` — défaut

### Décision actée — poids fixes, pas de renormalisation entre dimensions (2026-07-12)

Le Health Score composite garde des poids fixes entre dimensions (`payment_health`/`revenue_dynamics`/`contract_renewal`). **Aucune renormalisation dynamique** selon les dimensions disponibles.

**Raisons :**
- Comparabilité dans le temps : le score d'un compte ne doit pas varier uniquement parce qu'une dimension devient disponible/indisponible — sinon les courbes `score_history` deviennent illisibles.
- Volatilité : renormaliser ferait porter 100 % du poids sur une seule dimension restante quand les autres manquent — précisément sur les comptes les moins bien instrumentés.
- Explicabilité : un score qui varie parce que la formule change silencieusement selon les données disponibles est plus difficile à justifier qu'un score stable accompagné d'un statut de complétude séparé (`health_score_status`).

Cette décision est explicite et ne doit pas être remise en cause sans repasser par une décision produit documentée.

### Décision actée — comptes churnés exclus du churn risk (D1, 2026-08-02)

Un compte à `mrr_cents = 0` ou dont l'abonnement est `canceled` reçoit un état figé `churned` : il **sort** du calcul de `churn_risk_score`/`churn_risk_band` (plus de score calculé sur ses signaux historiques) et est **exclu** des listes « at risk », des KPIs « accounts at risk »/« MRR at risk » et des insights de churn. Un compte parti n'est pas « à risque », il est perdu. `determineSegmentTypesV3` assigne déjà `en_churn` sur ce critère (segment) — l'implémentation de cette décision consiste à réconcilier `churn_risk_score` persisté avec cet état (chantier Phase 2 / C2.1, voir `docs/CHANGELOG_STABILITY.md`). Ne pas revenir à un simple clamp du score : c'est un état figé distinct, pas une valeur basse.

## Edge Functions

| Fonction | Trigger | Rôle |
|----------|---------|------|
| `sync-stripe` | POST (cron) | Sync quotidien Stripe |
| `stripe-webhook` | POST (Stripe) | Webhooks temps réel |
| `calculate-scores` | POST (cron) | Scoring + segmentation |
| `generate-insights` | POST (cron) | Génération insights IA |
| `track-usage` | POST (webhook) | Events usage produit |
| `playbook-crud` | REST (JWT) | CRUD playbooks |
| `playbook-execute` | POST (JWT) | Exécution playbooks |
| `playbook-scheduler` | POST (cron) | Scheduler playbooks |
| `insights-crud` | REST (JWT) | CRUD insights |
| `health-check` | GET (5 min) | Monitoring |
| `self-monitor` | POST (15 min) | Auto-recovery |
| `admin-proxy` | REST (JWT) | Admin API |
| `workflow-step-processor` | POST | Workflow steps |
| `export-playbook-csv` | REST (JWT) | Chantier A : preview/export CSV playbook + run history |
| `subscription-status` | GET (JWT) | Chantier C : tier courant, usage vs plafond, catalogue tiers |
| `stripe-billing-checkout` | POST (JWT) | Chantier C : crée une Stripe Checkout Session (upgrade self-serve) |
| `stripe-billing-webhook` | POST (Stripe) | Chantier C : webhooks abonnement Sentio (compte Stripe propre, distinct de `stripe-webhook`) |

### Pattern Edge Function (obligatoire)

**REST/Webhook** : CORS → Auth → Parse → Tenant(org_id) → Logic → Persist → Response (<5s)

**Cron** : `acquireCronLock()` → try: logic + DataSyncLogger → catch: `logger.fail()` + `alertSlack()` → finally: `releaseCronLock()`

**Appels externes** : `fetchWithTimeout(8s)` + `retryWithBackoff(3x)` + `CircuitBreaker`

## Contraintes non-négociables

### Multi-Tenant & RLS
- IMPORTANT : chaque query DOIT être scopée par `organization_id`
- RLS = sécurité primaire. Toute nouvelle table DOIT avoir `organization_id`
- Helpers : `user_organization_id()`, `user_role()`

### Zero-PII
- IMPORTANT : ne JAMAIS stocker email, nom, téléphone, adresse, IP, SIRET lié à une personne

## Workflow par tâche (obligatoire)

1. **EXPLORE** — Lire les fichiers impactés (Plan Mode ou subagent Explore)
2. **PLAN** — Proposer un plan en 3-7 étapes, attendre validation
3. **CODE** — Implémenter en petits commits, écrire les tests d'abord quand possible
4. **VERIFY** — `npm run verify` (typecheck + lint + test + build)
5. **COMMIT** — Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`), résumer le diff

## Gestion du contexte

- `/clear` entre chaque tâche indépendante
- Subagents pour l'exploration (préserve le contexte principal)
- Après 2 corrections ratées → `/clear` + nouveau prompt incorporant les leçons

## Contraintes Claude Code

**DOIT :**
- Aligner avec `docs/openspec.md` et le Foundation doc
- Utiliser Context7 pour toute génération de code dépendant d'une librairie
- Consulter l'inventaire de réutilisabilité (section 6 Foundation) avant de créer un fichier
- Exécuter `npm run verify` après chaque série de modifications

**NE DOIT PAS :**
- Modifier les fondations multi-tenant sans approbation explicite
- Introduire de PII ou affaiblir les garanties Zero-PII
- Modifier les formules de scoring sans instruction explicite
- Ajouter d'infrastructure ou framework sans justification

## Anti-surengineering

- Solution la plus simple pour le V1
- Pas d'abstraction sauf si réutilisée 2+ fois
- Pas de package sans justification
- Code explicite > patterns cleveres

## Git

- Branche par tâche : `feat/`, `fix/`, `refactor/`, `docs/`
- Conventional Commits obligatoire
- Un commit doit compiler et passer les tests
- Résumer le diff avant chaque commit (`git diff --stat`)

## Spec Kit

Spec Kit structure le développement des features substantielles en pipeline : constitution → spec → plan → tasks → implement.

- **Constitution** : `.specify/memory/constitution.md` — règles non-négociables du projet (Zero-PII, RLS, multi-tenant, migrations, secrets, conventions), reprises de ce fichier CLAUDE.md.
- `/speckit-constitution` — crée ou met à jour la constitution du projet.
- `/speckit-specify` — crée la spécification d'une feature à partir d'une description en langage naturel.
- `/speckit-plan` — génère le plan d'implémentation technique à partir de la spec.
- `/speckit-tasks` — génère la liste de tâches ordonnée par dépendances à partir du plan.
- `/speckit-implement` — exécute les tâches définies dans `tasks.md`.

Toute feature substantielle doit passer par ce pipeline (constitution déjà en place → specify → plan → tasks) avant d'appeler `/speckit-implement`. Toute modification touchant RLS, les helpers multi-tenant ou l'architecture Zero-PII nécessite une validation explicite de l'utilisateur avant implémentation, même via `/speckit-implement` (règle également inscrite dans la constitution).

## Layout

```
/src                          — Next.js app
/docs                         — Specs et documentation
/supabase/functions           — Edge Functions (Deno)
/supabase/functions/_shared   — Utilities partagées
/supabase/migrations          — Migrations SQL
/supabase/tests               — Tests Vitest
/scripts                      — Scripts utilitaires
/.claude                      — Config Claude Code (hooks, skills, agents)
```

## Tables principales

`organizations`, `accounts`, `subscriptions`, `invoices`, `mrr_movements`, `usage_events`, `hubspot_companies`, `score_history`, `customer_segments`, `segment_memberships`, `ai_insights`, `playbooks`, `playbook_executions`, `data_syncs`, `webhook_configs`, `webhook_dead_letter`, `cron_locks`

## Variables d'environnement

| Variable | Req | Usage |
|----------|-----|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Oui | Client Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Oui | Client Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Oui | Server/Edge Functions |
| `STRIPE_SECRET_KEY` | Oui | API Stripe (compte Sentio elle-même) — OAuth callback (échange token client) ET Checkout Sessions (`stripe-billing-checkout`, chantier C) |
| `STRIPE_WEBHOOK_SECRET` | Oui | HMAC webhooks Stripe — comptes clients connectés (`stripe-webhook`) |
| `STRIPE_BILLING_WEBHOOK_SECRET` | Non | HMAC webhook abonnement Sentio (`stripe-billing-webhook`, chantier C) — 500 si absent quand ce endpoint est appelé, distinct de `STRIPE_WEBHOOK_SECRET` |
| `STRIPE_PRICE_ID_GROWTH` | Non | Price ID Stripe du tier Growth ($129/mo) — 503 sur `stripe-billing-checkout` si absent |
| `STRIPE_PRICE_ID_SCALE` | Non | Price ID Stripe du tier Scale ($349/mo) — 503 sur `stripe-billing-checkout` si absent |
| `STRIPE_CLIENT_ID` | Non* | OAuth Stripe (`stripe-oauth-initiate`) — fallback flow clé directe si absent |
| `HUBSPOT_API_KEY` | Non | Fallback global HubSpot (priorité 3, après Vault et `organizations.hubspot_api_key`) |
| `RESEND_API_KEY` | Non | Emails de bienvenue (`on-user-signup`) — log-only si absent |
| `ANTHROPIC_API_KEY` | Non | Résumés IA comptes (`account-summary`) — 503 si absent |
| `SLACK_WEBHOOK_URL` | Non | Alertes monitoring — silencieux si absent |
| `NEXT_PUBLIC_APP_URL` | Non | URL de base de l'app (OAuth redirect, Stripe Checkout success/cancel) — défaut `https://app.sentioapp.io` |

*Optionnel si le flow de connexion Stripe par clé directe (`verify-stripe-token`) est utilisé à la place.
