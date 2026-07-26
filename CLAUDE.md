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

## Scoring SaaS

```
Health Score = (Usage × 35%) + (Financial × 25%) + (Engagement × 20%) + (Contract × 20%)
Churn Risk  = 100 - Health Score + facteurs additifs (capped 100)
Expansion   = (seat_usage_pct × 60%) + (feature_ceiling × 40%)
```

Valeurs neutres (pas de données) : Usage=50, Engagement=50, Contrat=50, Financial=0.

8 segments : Champions, En expansion, Stables, À risque léger, En danger critique, Impayés, En churn, Nouveaux (<90j).

### Décision actée — poids fixes, pas de renormalisation (2026-07-12)

`health_score` garde des poids fixes et des valeurs neutres fixes en cas de signal manquant. **Aucune renormalisation dynamique des poids** selon les signaux disponibles (ex : ne pas recalculer `score = (financial×w1 + engagement×w2) / (w1+w2)` quand `product_usage` est absent).

**Raisons :**
- Comparabilité dans le temps : le score d'un compte ne doit pas varier uniquement parce qu'un tracker se connecte/déconnecte — sinon les courbes `score_history` deviennent illisibles.
- Volatilité : renormaliser ferait porter 100 % du poids sur un seul signal restant quand les autres manquent — précisément sur les comptes les moins bien instrumentés (souvent les plus récents).
- Explicabilité : un score qui varie parce que la formule change silencieusement selon les données disponibles est plus difficile à justifier auprès d'un CSM qu'un score stable accompagné d'un indicateur de complétude séparé.

Cette décision est explicite et ne doit pas être remise en cause par un futur agent sans repasser par une décision produit documentée. Le cas `Financial=0` (qui, contrairement à Usage/Engagement/Contrat, n'est pas une valeur neutre mais peut aussi signaler un vrai défaut de paiement via `overdue_count >= 5` dans `calcFinancialScore`, `_shared/scoring.ts`) reste un point ouvert distinct, à trancher séparément sur la base d'un diagnostic des comptes concernés.

**Diagnostic Financial=0 (exécuté 2026-07-12, environnement dev/démo confirmé — organisations `Sentio Demo`/`Test OAuth Corp`, données Stripe test-mode seedées en masse)** : sur les comptes `churn_risk_score >= 70`, 99,9 % ont `financial_score = 0`. En croisant avec `subscriptions`, ce `0` recouvre en réalité 3 cas distincts que `calcFinancialScore` ne différencie pas aujourd'hui : (1) 88 % n'ont jamais eu de ligne `subscriptions` — vraie absence de donnée, candidate à `=50` neutre ; (2) 12 % ont une `subscription` `canceled`/`past_due` avec `mrr_cents=0` — vrai churn, doit rester bas ; (3) `mrr_cents>0` avec `overdue_count>=5` — risque réel, déjà correctement traité. Design retenu pour une future implémentation (non codé, en attente de validation produit) : distinguer ces 3 cas en joignant `subscriptions`, pas seulement `mrrCents`. Proportions non fiables comme métriques business (données de démo), mais le design à 3 voies reste valide indépendamment du ratio réel.

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
| `STRIPE_SECRET_KEY` | Oui | API Stripe + OAuth callback |
| `STRIPE_WEBHOOK_SECRET` | Oui | HMAC webhooks Stripe |
| `STRIPE_CLIENT_ID` | Non* | OAuth Stripe (`stripe-oauth-initiate`) — fallback flow clé directe si absent |
| `HUBSPOT_API_KEY` | Non | Fallback global HubSpot (priorité 3, après Vault et `organizations.hubspot_api_key`) |
| `RESEND_API_KEY` | Non | Emails de bienvenue (`on-user-signup`) — log-only si absent |
| `ANTHROPIC_API_KEY` | Non | Résumés IA comptes (`account-summary`) — 503 si absent |
| `SLACK_WEBHOOK_URL` | Non | Alertes monitoring — silencieux si absent |
| `NEXT_PUBLIC_APP_URL` | Non | URL de base de l'app (OAuth redirect) — défaut `https://app.sentioapp.io` |

*Optionnel si le flow de connexion Stripe par clé directe (`verify-stripe-token`) est utilisé à la place.
