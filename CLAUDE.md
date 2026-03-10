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
| Tests | Vitest (529 tests) |
| CI/CD | GitHub Actions + Vercel |

**Phase actuelle** : setup/dev. Production intentionnellement inactif.

## Commandes

```bash
npm run dev          # Serveur Next.js local
npm run build        # Build production
npm run test         # Tests Vitest (543 tests)
npm run lint         # ESLint
npm run typecheck    # TypeScript check (tsc --noEmit)
npm run verify       # typecheck + lint + test + build (post-modification)
```

## Scoring SaaS

```
# V1 — usage tracker non connecté (3 dimensions)
Health Score = (Financial × 34%) + (Engagement × 33%) + (Contract × 33%)

# Futur — usage tracker connecté (4 dimensions)
Health Score = (Usage × 35%) + (Financial × 25%) + (Engagement × 20%) + (Contract × 20%)

Churn Risk  = 100 - Health Score + facteurs additifs (capped 100)
Expansion   = (seat_usage_pct × 60%) + (feature_ceiling × 40%)
```

`usage_tracker_connected` : détecté par `calculate-scores` (≥1 usage_event dans les 30 derniers jours). Stocké sur `accounts`.

Valeurs neutres (pas de données) : Engagement=50, Contrat=50, Financial=0. Usage=NULL quand tracker non connecté.

8 segments : Champions, En expansion, Stables, À risque léger, En danger critique, Impayés, En churn, Nouveaux (<90j).

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
| `export-playbook-accounts` | POST (JWT) | Export CSV/JSON comptes playbook |
| `export-segment-csv` | GET (JWT) | Export CSV comptes par segment (filtrage in-memory, BOM UTF-8) |
| `webhook-config` | REST (JWT) | Config webhook sortant (GET/POST, /test, /regenerate-secret, /disable) |
| `integration-oauth` | REST (JWT/CSRF) | OAuth Stripe Connect + HubSpot (authorize, callback, status, revoke) + API key Stripe (POST /stripe/api-key) + API key HubSpot (POST /hubspot/api-key) |
| `sync-hubspot` | POST (cron) | Sync HubSpot companies (OAuth/API key Vault, Zero-PII) |
| `refresh-hubspot-tokens` | POST (cron 5h) | Refresh tokens HubSpot avant expiration 6h |

### Pattern Edge Function (obligatoire)

**REST/Webhook** : CORS → Auth → Parse → Tenant(org_id) → Logic → Persist → Response (<5s)

**Cron** : `acquireCronLock()` → try: logic + DataSyncLogger → catch: `logger.fail()` + `alertSlack()` → finally: `releaseCronLock()`

**Appels externes** : `fetchWithTimeout(8s)` + `retryWithBackoff(3x)` + `CircuitBreaker`

## Contraintes non-négociables

### Multi-Tenant & RLS
- IMPORTANT : chaque query DOIT être scopée par `organization_id`
- RLS = sécurité primaire. Toute nouvelle table DOIT avoir `organization_id`
- Helpers : `user_organization_id()`, `user_role()`
- Auto-profile : trigger `on_auth_user_created` sur `auth.users` crée `profiles_` avec `organization_id` depuis `invitations` + safeguard dans `auth/callback`

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

`organizations`, `accounts`, `subscriptions`, `invoices`, `mrr_movements`, `usage_events`, `hubspot_companies`, `score_history`, `customer_segments`, `segment_memberships`, `ai_insights`, `playbooks`, `playbook_executions`, `playbook_exports`, `data_syncs`, `webhook_configs`, `webhook_dead_letter`, `cron_locks`, `organization_integrations`, `oauth_states`

## Variables d'environnement

| Variable | Req | Usage |
|----------|-----|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Oui | Client Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Oui | Client Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Oui | Server/Edge Functions |
| `STRIPE_SECRET_KEY` | Oui | API Stripe |
| `STRIPE_WEBHOOK_SECRET` | Oui | HMAC webhooks |
| `HUBSPOT_API_KEY` | Non | API HubSpot (legacy, remplacé par OAuth) |
| `SLACK_WEBHOOK_URL` | Non | Alertes monitoring |
| `STRIPE_CONNECT_CLIENT_ID` | Non | OAuth Stripe Connect (ca_xxx) |
| `STRIPE_OAUTH_REDIRECT_URI` | Non | Callback OAuth Stripe |
| `HUBSPOT_CLIENT_ID` | Non | OAuth HubSpot app |
| `HUBSPOT_CLIENT_SECRET` | Non | OAuth HubSpot app |
| `HUBSPOT_OAUTH_REDIRECT_URI` | Non | Callback OAuth HubSpot |
