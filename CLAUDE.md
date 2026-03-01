# CLAUDE.md — Sentio AI SaaS FR

Ce fichier fournit les instructions à Claude Code pour travailler sur ce repo.

## Source de vérité (obligatoire)

Claude Code doit traiter ces documents comme faisant autorité :
- Spécification produit : `docs/openspec.md`
- Règles de validation : `docs/test-spec/*`
- Instructions Claude : `CLAUDE.md`
- Document de fondation : `docs/SENTIO_AI_SaaS_FR_Projet_Foundation.md`

En cas de conflit :
1) `docs/openspec.md` prime sur tout
2) Les test specs définissent le comportement attendu
3) L'implémentation s'adapte

## Vue d'ensemble

Sentio AI SaaS FR est une plateforme de Customer Intelligence pour éditeurs SaaS B2B francophones. Elle ingère les données Stripe (facturation), HubSpot (engagement commercial) et usage produit pour calculer des scores de santé client, détecter les risques de churn et identifier les opportunités d'expansion.

**Architecture Zero-PII** : la plateforme ne stocke jamais d'email, nom, téléphone, adresse IP ou données personnelles. Uniquement des identifiants anonymes et des métriques comportementales agrégées.

## Stack technique

| Couche | Technologie |
|--------|-------------|
| Base de données | Supabase PostgreSQL + RLS |
| Backend | Supabase Edge Functions (Deno) |
| Frontend | Next.js 14 App Router |
| Langage | TypeScript 5.x (target ES5 — pas de `[...new Set()]`) |
| Styling | Tailwind CSS 3.x |
| Auth | @supabase/ssr (cookies, PKCE) |
| Tests | Vitest |
| CI/CD | GitHub Actions + Vercel |
| Intégrations | Stripe, HubSpot |

## Phase actuelle

Le projet est en **phase de setup et développement**.
Le déploiement production est **intentionnellement inactif**.
Claude ne doit pas supposer une production-readiness sauf instruction explicite.

## Tables principales

| Table | Rôle |
|-------|------|
| `organizations` | Config multi-tenant, credentials API |
| `accounts` | Comptes clients SaaS (remplace `customers`) |
| `subscriptions` | Abonnements Stripe par account |
| `invoices` | Factures Stripe |
| `mrr_movements` | Log des mouvements MRR (new/expansion/contraction/churn/reactivation) |
| `usage_events` | Événements d'usage produit |
| `hubspot_companies` | Données HubSpot par account |
| `score_history` | Snapshots quotidiens des scores |
| `customer_segments` | Définitions de segments |
| `segment_memberships` | Assignations account→segment |
| `ai_insights` | Insights IA générés |
| `playbooks` | Définitions de playbooks rétention |
| `playbook_executions` | Journal d'exécution |
| `data_syncs` | Journal des synchronisations |
| `webhook_configs` | Credentials HMAC par org/provider |
| `webhook_dead_letter` | DLQ webhooks échoués |
| `cron_locks` | Verrouillage distribué cron |

## Moteur de scoring SaaS

```
Health Score = (Usage × 35%) + (Financial × 25%) + (Engagement × 20%) + (Contract × 20%)
Churn Risk = 100 - Health Score + facteurs de risque additifs (capped 100)
Expansion Score = (seat_usage_pct × 60%) + (feature_ceiling × 40%)
```

## Segments SaaS B2B

Champions, En expansion, Stables, À risque léger, En danger critique, Impayés, En churn, Nouveaux (< 90j).

## Intégrations

- **Stripe** : source de vérité financière (webhooks + sync quotidien)
- **HubSpot** : engagement commercial (sync quotidien companies/deals/tickets)
- **Usage produit** : endpoint webhook direct `POST /functions/v1/track-usage`

## Edge Function Pattern (Deno)

Pour toute nouvelle Edge Function :
1. Auth / vérification HMAC
2. Parse + validation payload
3. Résolution du tenant (organization_id)
4. Logique métier
5. Persistance
6. Réponse rapide (< 5s pour webhooks)

## Multi-Tenant & RLS (non-négociable)

- Chaque query scopée par `organization_id`
- RLS = couche de sécurité primaire
- Toute nouvelle table DOIT avoir `organization_id`
- Helpers : `user_organization_id()`, `user_role()`

## Zero-PII (non-négociable)

Ne jamais stocker : email, nom, téléphone, adresse, IP, SIRET lié à une personne.
Identifiants autorisés : `stripe_customer_id`, `hubspot_company_id` (anonymes).

## Commandes

```bash
npm run dev          # Serveur Next.js local
npm run build        # Build production
npm run test         # Tests Vitest
npm run lint         # ESLint
```

## Variables d'environnement

| Variable | Obligatoire | Usage |
|----------|-------------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Oui | Client-side Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Oui | Client-side Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Oui | Server-side / Edge Functions |
| `STRIPE_SECRET_KEY` | Oui | API Stripe |
| `STRIPE_WEBHOOK_SECRET` | Oui | Validation HMAC webhooks Stripe |
| `HUBSPOT_API_KEY` | Non | API HubSpot |
| `SLACK_WEBHOOK_URL` | Non | Alertes monitoring |

## Contraintes Claude Code

Claude Code DOIT :
- Aligner avec `docs/openspec.md` et `docs/SENTIO_AI_SaaS_FR_Projet_Foundation.md`
- Respecter la phase actuelle (setup/dev uniquement)
- Utiliser Context7 pour toute génération de code dépendant d'une librairie
- Consulter l'inventaire de réutilisabilité (section 6 du Foundation doc) avant de créer un fichier

Claude Code NE DOIT PAS :
- Modifier les fondations multi-tenant sans approbation explicite
- Introduire de PII ou affaiblir les garanties Zero-PII
- Modifier les formules de scoring sans instruction explicite
- Ajouter d'infrastructure ou framework sans justification

## Working Pattern (obligatoire)

Pour chaque tâche :
1. Reformuler l'objectif en 1-2 lignes
2. Identifier les zones impactées
3. Si l'archi/specs changent, mettre à jour /docs d'abord
4. Proposer un plan minimal (3-7 étapes)
5. Implémenter en petits commits
6. Fournir une checklist de vérification

## Anti-surengineering

- Solution la plus simple pour le V1
- Pas d'abstraction sauf si réutilisée 2+ fois
- Pas de package sans justification
- Code explicite > patterns cleveres

## Layout du repo

- `/src` — code applicatif Next.js
- `/docs` — documentation et specs
- `/supabase/functions` — Edge Functions (Deno)
- `/supabase/migrations` — migrations SQL
- `/supabase/tests` — tests
- `/scripts` — scripts utilitaires
- `/.claude` — config Claude Code
- `/.env.example` — template (commité)
- `/.env.local` — secrets (JAMAIS commité)

## Context7 (obligatoire)

Toujours utiliser Context7 pour récupérer la doc à jour avant de générer du code dépendant d'une librairie. Ne pas deviner les signatures d'API.
